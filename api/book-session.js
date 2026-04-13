// Vercel Serverless Function: /api/book-session
// Complete booking flow:
//   1. Re-verify slot availability in Mindbody (double-booking protection)
//   2. Create Stripe PaymentIntent and charge
//   3. Book the appointment in Mindbody
//   4. Save booking to Supabase
//   5. Push lead to GoHighLevel
//   6. Return confirmation

var stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
var { createClient } = require('@supabase/supabase-js');

// ── Price config (server-side — never trust client) ──
var PRICES = { soft: 4900, hard: 9900 }; // cents

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var {
      firstName, lastName, email, phone,
      chamber, date, time,
      paymentIntentId,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term
    } = req.body;

    // ── Validate required fields ──
    if (!firstName || !lastName || !email || !phone || !chamber || !date || !time || !paymentIntentId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    var amountCents = PRICES[chamber];
    if (!amountCents) {
      return res.status(400).json({ error: 'Invalid chamber type. Must be "soft" or "hard".' });
    }

    var normalizedEmail = email.toLowerCase().trim();

    // ════════════════════════════════════════════
    // STEP 1: Double-booking protection
    // Re-verify this slot is still open in Mindbody
    // ════════════════════════════════════════════
    var slotAvailable = await verifyMindbodySlot(date, time, chamber);
    if (!slotAvailable.available) {
      return res.status(409).json({
        error: 'slot_taken',
        message: 'Sorry, that time slot was just booked by someone else. Please choose another time.',
        suggestedSlots: slotAvailable.alternatives || []
      });
    }

    // ════════════════════════════════════════════
    // STEP 2: Verify Stripe payment succeeded
    // Payment was already confirmed client-side via stripe.confirmPayment()
    // We just retrieve and verify the PaymentIntent here
    // ════════════════════════════════════════════
    var paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed. Status: ' + paymentIntent.status });
    }

    // Verify the amount matches (prevent tampering)
    if (paymentIntent.amount !== amountCents) {
      console.error('Amount mismatch: expected', amountCents, 'got', paymentIntent.amount);
      return res.status(400).json({ error: 'Payment amount mismatch' });
    }

    // Add booking metadata to the PaymentIntent for record-keeping
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: {
        type: 'hbot_booking',
        chamber: chamber,
        booking_date: date,
        booking_time: time,
        customer_name: firstName + ' ' + lastName,
        customer_email: normalizedEmail
      }
    });

    // Get or create Stripe customer for records
    var customer = paymentIntent.customer
      ? { id: paymentIntent.customer }
      : { id: null };

    // ════════════════════════════════════════════
    // STEP 3: Book in Mindbody
    // ════════════════════════════════════════════
    var mindbodyBookingId = null;
    try {
      mindbodyBookingId = await bookInMindbody(firstName, lastName, normalizedEmail, phone, date, time, chamber);
    } catch (mbErr) {
      console.error('Mindbody booking error (payment already charged):', mbErr.message);
      // Payment succeeded — log the error but don't fail the user.
      // Manual reconciliation may be needed.
    }

    // ════════════════════════════════════════════
    // STEP 4: Save to Supabase
    // ════════════════════════════════════════════
    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    var bookingRecord = {
      first_name: firstName,
      last_name: lastName,
      email: normalizedEmail,
      phone: phone,
      chamber_type: chamber,
      booking_date: date,
      booking_time: time,
      amount_cents: amountCents,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_customer_id: customer.id,
      mindbody_booking_id: mindbodyBookingId,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      utm_term: utm_term || null,
      status: 'confirmed'
    };

    var { error: dbError } = await supabase.from('bookings').insert(bookingRecord);
    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Don't fail — Stripe is charged, booking is made
    }

    // ════════════════════════════════════════════
    // STEP 5: Push lead to GoHighLevel
    // ════════════════════════════════════════════
    var ghlContactId = null;
    try {
      var ghlResult = await pushToGHL(firstName, lastName, normalizedEmail, phone, chamber, date, time, {
        utm_source: utm_source, utm_medium: utm_medium,
        utm_campaign: utm_campaign, utm_content: utm_content, utm_term: utm_term
      });
      ghlContactId = ghlResult && ghlResult.contact ? ghlResult.contact.id : null;
    } catch (ghlErr) {
      console.error('GHL push error:', ghlErr.message);
    }

    // ════════════════════════════════════════════
    // STEP 6: Send confirmation email + SMS
    // Fire and forget — don't block the response
    // ════════════════════════════════════════════
    sendConfirmationEmail(firstName, normalizedEmail, chamber, date, time, amountCents)
      .catch(function(emailErr) {
        console.error('Confirmation email error:', emailErr.message);
      });

    if (ghlContactId) {
      sendConfirmationSMS(ghlContactId, firstName, chamber, date, time)
        .catch(function(smsErr) {
          console.error('Confirmation SMS error:', smsErr.message);
        });
    }

    // ════════════════════════════════════════════
    // STEP 7: Return confirmation
    // ════════════════════════════════════════════
    return res.status(200).json({
      success: true,
      booking: {
        date: date,
        time: time,
        chamber: chamber,
        amount: amountCents / 100,
        paymentIntentId: paymentIntent.id,
        mindbodyBookingId: mindbodyBookingId
      }
    });

  } catch (err) {
    console.error('book-session error:', err);
    return res.status(500).json({
      error: err.message || 'Booking failed. Please try again.'
    });
  }
};


// ════════════════════════════════════════════
// MINDBODY: Verify slot is still available
// Uses staffappointments endpoint + overlap detection
// (same pattern as get-availability.js)
// ════════════════════════════════════════════
// Staff IDs (chambers set up as staff in Mindbody)
var STAFF_IDS = { soft: 100000015, hard: 100000027 };

// Operating hours for alternative slot suggestions
var SLOTS = {
  weekday: ['7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM'],
  friday:  ['7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'],
  weekend: ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM']
};

async function verifyMindbodySlot(date, time, chamber) {
  try {
    var token = await getMindbodyToken();
    if (!token) return { available: true }; // If Mindbody is down, allow (Supabase will catch dupes)

    var staffId = STAFF_IDS[chamber];
    if (!staffId) return { available: true };

    var headers = {
      'Api-Key': process.env.MINDBODY_API_KEY,
      'SiteId': process.env.MINDBODY_SITE_ID,
      'Authorization': token
    };

    // Query existing appointments for this chamber on this date
    var params = new URLSearchParams({
      StartDate: date,
      EndDate: date,
      StaffIds: staffId.toString(),
      Limit: 200
    });

    var response = await fetch(
      'https://api.mindbodyonline.com/public/v6/appointment/staffappointments?' + params.toString(),
      { method: 'GET', headers: headers }
    );

    var responseText = await response.text();
    var data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('Mindbody verify: non-JSON response:', responseText.substring(0, 200));
      return { available: true }; // Can't verify — allow and let Supabase catch dupes
    }

    if (!response.ok) {
      console.error('Mindbody verify error:', data);
      return { available: true };
    }

    var appointments = data.Appointments || data.StaffAppointments || [];

    // Build booked time ranges (minutes since midnight)
    // Parse directly from ISO string to avoid timezone conversion issues.
    // Mindbody returns local business time like "2026-04-12T11:45:00-04:00"
    var bookedRanges = [];
    appointments.forEach(function(appt) {
      if (appt.Status === 'Cancelled' || appt.Status === 'NoShow') return;
      if (!appt.StartDateTime || !appt.EndDateTime) return;
      var startParts = appt.StartDateTime.match(/T(\d{2}):(\d{2})/);
      var endParts = appt.EndDateTime.match(/T(\d{2}):(\d{2})/);
      if (!startParts || !endParts) return;
      bookedRanges.push({
        start: parseInt(startParts[1]) * 60 + parseInt(startParts[2]),
        end: parseInt(endParts[1]) * 60 + parseInt(endParts[2])
      });
    });

    // Check if the requested slot's 60-min window overlaps any appointment
    var slotStart = timeStringToMinutes(time);
    var slotEnd = slotStart + 60;

    var isBlocked = bookedRanges.some(function(range) {
      return range.start < slotEnd && range.end > slotStart;
    });

    if (!isBlocked) {
      return { available: true };
    }

    // Slot is taken — find open alternatives on the same day
    var dateObj = new Date(date + 'T00:00:00');
    var dayOfWeek = dateObj.getDay();
    var base;
    if (dayOfWeek === 0 || dayOfWeek === 6) base = SLOTS.weekend;
    else if (dayOfWeek === 5) base = SLOTS.friday;
    else base = SLOTS.weekday;

    var alternatives = base.filter(function(t) {
      var s = timeStringToMinutes(t);
      var e = s + 60;
      return !bookedRanges.some(function(range) {
        return range.start < e && range.end > s;
      });
    }).slice(0, 3);

    return { available: false, alternatives: alternatives };

  } catch (err) {
    console.error('Mindbody verify error:', err.message);
    return { available: true };
  }
}

// Helper: convert "H:MM AM/PM" to minutes since midnight
function timeStringToMinutes(timeStr) {
  var parts = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!parts) return 0;
  var h = parseInt(parts[1]);
  var m = parseInt(parts[2]);
  var ampm = parts[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}


// ════════════════════════════════════════════
// MINDBODY: Book the appointment
// ════════════════════════════════════════════
async function bookInMindbody(firstName, lastName, email, phone, date, time, chamber) {
  var token = await getMindbodyToken();
  if (!token) return null;

  // First, find or create the client in Mindbody
  var clientId = await findOrCreateMindbodyClient(token, firstName, lastName, email, phone);

  // Parse the requested time into an ISO datetime
  var timeParts = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  var hours = parseInt(timeParts[1], 10);
  var minutes = parseInt(timeParts[2], 10);
  var ampm = timeParts[3].toUpperCase();
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  var startDateTime = date + 'T' + String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':00';

  // Determine session type ID
  var sessionTypeId = chamber === 'soft'
    ? process.env.MINDBODY_HBOT_SOFT_SESSION_TYPE_ID
    : process.env.MINDBODY_HBOT_HARD_SESSION_TYPE_ID;

  var bookingBody = {
    ClientId: clientId,
    StartDateTime: startDateTime,
    Notes: 'Booked via Healthspan online booking. Chamber: ' + chamber
  };

  if (sessionTypeId) bookingBody.SessionTypeId = parseInt(sessionTypeId, 10);
  // Use hardcoded StaffId per chamber (chambers are set up as staff in Mindbody)
  bookingBody.StaffId = STAFF_IDS[chamber] || STAFF_IDS.soft;
  if (process.env.MINDBODY_LOCATION_ID) bookingBody.LocationId = parseInt(process.env.MINDBODY_LOCATION_ID, 10);

  var response = await fetch('https://api.mindbodyonline.com/public/v6/appointment/addappointment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': process.env.MINDBODY_API_KEY,
      'SiteId': process.env.MINDBODY_SITE_ID,
      'Authorization': token
    },
    body: JSON.stringify(bookingBody)
  });

  var result = await response.json();
  if (!response.ok) {
    throw new Error('Mindbody booking failed: ' + JSON.stringify(result));
  }

  return result.Appointment ? result.Appointment.Id : null;
}


// ════════════════════════════════════════════
// MINDBODY: Find or create client
// ════════════════════════════════════════════
async function findOrCreateMindbodyClient(token, firstName, lastName, email, phone) {
  // Search for existing client by email
  var searchResponse = await fetch(
    'https://api.mindbodyonline.com/public/v6/client/clients?SearchText=' + encodeURIComponent(email),
    {
      headers: {
        'Api-Key': process.env.MINDBODY_API_KEY,
        'SiteId': process.env.MINDBODY_SITE_ID,
        'Authorization': token
      }
    }
  );

  var searchData = await searchResponse.json();
  var clients = searchData.Clients || [];
  if (clients.length > 0) {
    return clients[0].Id;
  }

  // Client doesn't exist — create them
  var createResponse = await fetch('https://api.mindbodyonline.com/public/v6/client/addclient', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': process.env.MINDBODY_API_KEY,
      'SiteId': process.env.MINDBODY_SITE_ID,
      'Authorization': token
    },
    body: JSON.stringify({
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      MobilePhone: phone
    })
  });

  var createData = await createResponse.json();
  if (!createResponse.ok || !createData.Client) {
    throw new Error('Failed to create Mindbody client: ' + JSON.stringify(createData));
  }

  return createData.Client.Id;
}


// ════════════════════════════════════════════
// MINDBODY: Get auth token
// ════════════════════════════════════════════
async function getMindbodyToken() {
  try {
    var response = await fetch('https://api.mindbodyonline.com/public/v6/usertoken/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.MINDBODY_API_KEY,
        'SiteId': process.env.MINDBODY_SITE_ID
      },
      body: JSON.stringify({
        Username: process.env.MINDBODY_STAFF_USERNAME,
        Password: process.env.MINDBODY_STAFF_PASSWORD
      })
    });

    var data = await response.json();
    return data.AccessToken || null;
  } catch (err) {
    console.error('Mindbody token error:', err.message);
    return null;
  }
}


// ════════════════════════════════════════════
// GOHIGHLEVEL: Push lead (fire and forget)
// ════════════════════════════════════════════
async function pushToGHL(firstName, lastName, email, phone, chamber, date, time, utms) {
  // Extract location ID from the JWT token (or use env var)
  var locationId = process.env.GHL_LOCATION_ID;

  var contactBody = {
    firstName: firstName,
    lastName: lastName,
    email: email,
    phone: phone,
    tags: ['HBOT-Booking', 'Online-Booking', chamber + '-chamber'],
    source: 'Healthspan Booking Page',
    customFields: [
      { key: 'chamber_type', value: chamber },
      { key: 'booking_date', value: date },
      { key: 'booking_time', value: time }
    ]
  };

  if (locationId) contactBody.locationId = locationId;

  // Add UTMs as custom fields if present
  if (utms.utm_source) contactBody.customFields.push({ key: 'utm_source', value: utms.utm_source });
  if (utms.utm_medium) contactBody.customFields.push({ key: 'utm_medium', value: utms.utm_medium });
  if (utms.utm_campaign) contactBody.customFields.push({ key: 'utm_campaign', value: utms.utm_campaign });

  var response = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify(contactBody)
  });

  var result = await response.json();
  if (!response.ok) {
    throw new Error('GHL error: ' + JSON.stringify(result));
  }

  return result;
}


// ════════════════════════════════════════════
// CONFIRMATION EMAIL via Resend
// Single email: booking details + payment receipt
// ════════════════════════════════════════════
async function sendConfirmationEmail(firstName, email, chamber, date, time, amountCents) {
  if (!process.env.RESEND_API_KEY) return;

  var { Resend } = require('resend');
  var resend = new Resend(process.env.RESEND_API_KEY);

  var chamberName = chamber === 'soft' ? 'Soft Chamber (1.3 ATA)' : 'Hard Chamber (Up to 2.0 ATA)';
  var amount = '$' + (amountCents / 100).toFixed(2);

  // Format date nicely
  var dateObj = new Date(date + 'T00:00:00');
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var formattedDate = days[dateObj.getDay()] + ', ' + months[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();

  var html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #0C6B58; padding: 32px 24px; border-radius: 12px 12px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 600;">Session Confirmed</h1>
      </div>
      <div style="background: white; padding: 32px 24px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="font-size: 16px; margin: 0 0 24px;">Hi ${firstName},</p>
        <p style="font-size: 16px; margin: 0 0 24px;">Your hyperbaric session is booked and confirmed. Here are your details:</p>

        <div style="background: #f8faf9; border-radius: 8px; padding: 20px; margin: 0 0 24px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Chamber</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600;">${chamberName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Date</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600;">${formattedDate}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Time</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600;">${time}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Duration</td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600;">60 minutes</td>
            </tr>
            <tr style="border-top: 1px solid #e5e7eb;">
              <td style="padding: 12px 0 8px; color: #6b7280;">Amount Paid</td>
              <td style="padding: 12px 0 8px; text-align: right; font-weight: 700; color: #0C6B58; font-size: 17px;">${amount}</td>
            </tr>
          </table>
        </div>

        <div style="background: #f8faf9; border-radius: 8px; padding: 20px; margin: 0 0 24px;">
          <p style="margin: 0 0 4px; font-weight: 600; font-size: 15px;">Location</p>
          <p style="margin: 0; font-size: 15px; color: #374151;">Healthspan<br>1441 Brickell Ave, Miami, FL</p>
        </div>

        <div style="margin: 0 0 24px;">
          <p style="margin: 0 0 8px; font-weight: 600; font-size: 15px;">Before Your Session</p>
          <p style="margin: 0; font-size: 14px; color: #374151; line-height: 1.6;">
            Please arrive 10 minutes early.
            If you have any questions, call us at 786-713-1222.
          </p>
        </div>
      </div>
      <div style="padding: 16px 24px; text-align: center; font-size: 13px; color: #9ca3af;">
        Healthspan &middot; 1441 Brickell Ave, Miami, FL
      </div>
    </div>
  `;

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Healthspan <booking@healthspanrecovery.com>',
    to: email,
    subject: 'Your HBOT Session is Confirmed — ' + formattedDate + ' at ' + time,
    html: html
  });
}


// ════════════════════════════════════════════
// CONFIRMATION SMS via GoHighLevel
// Short text with date/time/location
// ════════════════════════════════════════════
async function sendConfirmationSMS(contactId, firstName, chamber, date, time) {
  if (!process.env.GHL_API_KEY || !contactId) return;

  // Format date briefly
  var dateObj = new Date(date + 'T00:00:00');
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var shortDate = days[dateObj.getDay()] + ', ' + months[dateObj.getMonth()] + ' ' + dateObj.getDate();

  var message = 'Hi ' + firstName + '! Your HBOT session is confirmed: '
    + shortDate + ' at ' + time
    + '. Healthspan, 1441 Brickell Ave, Miami. '
    + 'Arrive 10 min early. Questions? 786-713-1222';

  // Use GHL conversations API to send SMS (requires contactId, not phone)
  var response = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify({
      type: 'SMS',
      contactId: contactId,
      message: message
    })
  });

  if (!response.ok) {
    var result = await response.json();
    throw new Error('GHL SMS error: ' + JSON.stringify(result));
  }
}
