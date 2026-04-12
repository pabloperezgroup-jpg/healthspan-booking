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
      paymentMethodId,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term
    } = req.body;

    // ── Validate required fields ──
    if (!firstName || !lastName || !email || !phone || !chamber || !date || !time || !paymentMethodId) {
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
    // STEP 2: Charge via Stripe
    // ════════════════════════════════════════════
    // Create or retrieve Stripe customer
    var customer;
    var existingCustomers = await stripe.customers.list({ email: normalizedEmail, limit: 1 });
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: normalizedEmail,
        name: firstName + ' ' + lastName,
        phone: phone
      });
    }

    // Attach payment method
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } catch (attachErr) {
      if (!attachErr.message || !attachErr.message.includes('already been attached')) {
        throw attachErr;
      }
    }

    // Create and confirm payment
    var paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customer.id,
      payment_method: paymentMethodId,
      payment_method_types: ['card'],
      confirm: true,
      off_session: false,
      receipt_email: normalizedEmail,
      metadata: {
        type: 'hbot_booking',
        chamber: chamber,
        booking_date: date,
        booking_time: time,
        customer_name: firstName + ' ' + lastName,
        customer_email: normalizedEmail
      }
    });

    // Handle 3D Secure
    if (paymentIntent.status === 'requires_action') {
      return res.status(200).json({
        success: false,
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment failed: ' + paymentIntent.status });
    }

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
    pushToGHL(firstName, lastName, normalizedEmail, phone, chamber, date, time, {
      utm_source: utm_source, utm_medium: utm_medium,
      utm_campaign: utm_campaign, utm_content: utm_content, utm_term: utm_term
    }).catch(function(ghlErr) {
      // Fire and forget — don't block the booking confirmation
      console.error('GHL push error:', ghlErr.message);
    });

    // ════════════════════════════════════════════
    // STEP 6: Return confirmation
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
    var bookedRanges = [];
    appointments.forEach(function(appt) {
      if (appt.Status === 'Cancelled' || appt.Status === 'NoShow') return;
      if (!appt.StartDateTime || !appt.EndDateTime) return;
      var startDt = new Date(appt.StartDateTime);
      var endDt = new Date(appt.EndDateTime);
      bookedRanges.push({
        start: startDt.getHours() * 60 + startDt.getMinutes(),
        end: endDt.getHours() * 60 + endDt.getMinutes()
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
