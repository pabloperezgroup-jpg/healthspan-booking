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

var PRICES = { soft: 4900, hard: 9900 };

module.exports = async (req, res) => {
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

    if (!firstName || !lastName || !email || !phone || !chamber || !date || !time || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    var amountCents = PRICES[chamber];
    if (!amountCents) {
      return res.status(400).json({ error: 'Invalid chamber type. Must be "soft" or "hard".' });
    }

    var normalizedEmail = email.toLowerCase().trim();

    // STEP 1: Double-booking protection
    var slotAvailable = await verifyMindbodySlot(date, time, chamber);
    if (!slotAvailable.available) {
      return res.status(409).json({
        error: 'slot_taken',
        message: 'Sorry, that time slot was just booked. Please choose another time.',
        suggestedSlots: slotAvailable.alternatives || []
      });
    }

    // STEP 2: Charge via Stripe
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

    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } catch (attachErr) {
      if (!attachErr.message || !attachErr.message.includes('already been attached')) {
        throw attachErr;
      }
    }

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

    // STEP 3: Book in Mindbody
    var mindbodyBookingId = null;
    try {
      mindbodyBookingId = await bookInMindbody(firstName, lastName, normalizedEmail, phone, date, time, chamber);
    } catch (mbErr) {
      console.error('Mindbody booking error (payment already charged):', mbErr.message);
    }

    // STEP 4: Save to Supabase
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
    if (dbError) console.error('Supabase insert error:', dbError);

    // STEP 5: Push lead to GoHighLevel
    pushToGHL(firstName, lastName, normalizedEmail, phone, chamber, date, time, {
      utm_source: utm_source, utm_medium: utm_medium,
      utm_campaign: utm_campaign, utm_content: utm_content, utm_term: utm_term
    }).catch(function(ghlErr) {
      console.error('GHL push error:', ghlErr.message);
    });

    // STEP 6: Return confirmation
    return res.status(200).json({
      success: true,
      booking: {
        date: date, time: time, chamber: chamber,
        amount: amountCents / 100,
        paymentIntentId: paymentIntent.id,
        mindbodyBookingId: mindbodyBookingId
      }
    });

  } catch (err) {
    console.error('book-session error:', err);
    return res.status(500).json({ error: err.message || 'Booking failed. Please try again.' });
  }
};


async function verifyMindbodySlot(date, time, chamber) {
  try {
    var token = await getMindbodyToken();
    if (!token) return { available: true };
    var params = new URLSearchParams({ StartDate: date, EndDate: date, Limit: 100 });
    var envKey = chamber === 'soft' ? 'MINDBODY_HBOT_SOFT_SESSION_TYPE_ID' : 'MINDBODY_HBOT_HARD_SESSION_TYPE_ID';
    if (process.env[envKey]) params.append('SessionTypeIds', process.env[envKey]);

    var response = await fetch(
      'https://api.mindbodyonline.com/public/v6/appointment/bookableitems?' + params.toString(),
      { headers: { 'Api-Key': process.env.MINDBODY_API_KEY, 'SiteId': process.env.MINDBODY_SITE_ID, 'Authorization': token } }
    );
    var data = await response.json();
    var items = data.BookableItems || data.AvailableItems || [];
    var requestedTime = time.toUpperCase().replace(/\s+/g, ' ');
    var match = items.find(function(item) {
      if (!item.StartDateTime) return false;
      var dt = new Date(item.StartDateTime);
      var h = dt.getHours(), m = dt.getMinutes();
      var ampm = h >= 12 ? 'PM' : 'AM';
      var slotTime = ((h % 12 || 12) + ':' + (m === 0 ? '00' : String(m).padStart(2,'0')) + ' ' + ampm).toUpperCase();
      return slotTime === requestedTime;
    });
    if (match) return { available: true, slotData: match };
    var alts = items.slice(0,3).map(function(item) {
      var dt = new Date(item.StartDateTime);
      var h = dt.getHours(), m = dt.getMinutes();
      return (h % 12 || 12) + ':' + (m === 0 ? '00' : String(m).padStart(2,'0')) + ' ' + (h >= 12 ? 'PM' : 'AM');
    });
    return { available: false, alternatives: alts };
  } catch (err) {
    console.error('Mindbody verify error:', err.message);
    return { available: true };
  }
}


async function bookInMindbody(firstName, lastName, email, phone, date, time, chamber) {
  var token = await getMindbodyToken();
  if (!token) return null;
  var clientId = await findOrCreateMindbodyClient(token, firstName, lastName, email, phone);
  var tp = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  var hours = parseInt(tp[1],10), minutes = parseInt(tp[2],10), ampm = tp[3].toUpperCase();
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  var startDT = date + 'T' + String(hours).padStart(2,'0') + ':' + String(minutes).padStart(2,'0') + ':00';
  var stId = chamber === 'soft' ? process.env.MINDBODY_HBOT_SOFT_SESSION_TYPE_ID : process.env.MINDBODY_HBOT_HARD_SESSION_TYPE_ID;
  var body = { ClientId: clientId, StartDateTime: startDT, Notes: 'Booked via Healthspan online. Chamber: ' + chamber };
  if (stId) body.SessionTypeId = parseInt(stId, 10);
  if (process.env.MINDBODY_STAFF_ID) body.StaffId = parseInt(process.env.MINDBODY_STAFF_ID, 10);
  if (process.env.MINDBODY_LOCATION_ID) body.LocationId = parseInt(process.env.MINDBODY_LOCATION_ID, 10);
  var resp = await fetch('https://api.mindbodyonline.com/public/v6/appointment/addappointment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.MINDBODY_API_KEY, 'SiteId': process.env.MINDBODY_SITE_ID, 'Authorization': token },
    body: JSON.stringify(body)
  });
  var result = await resp.json();
  if (!resp.ok) throw new Error('Mindbody booking failed: ' + JSON.stringify(result));
  return result.Appointment ? result.Appointment.Id : null;
}


async function findOrCreateMindbodyClient(token, firstName, lastName, email, phone) {
  var sr = await fetch('https://api.mindbodyonline.com/public/v6/client/clients?SearchText=' + encodeURIComponent(email), {
    headers: { 'Api-Key': process.env.MINDBODY_API_KEY, 'SiteId': process.env.MINDBODY_SITE_ID, 'Authorization': token }
  });
  var sd = await sr.json();
  if ((sd.Clients || []).length > 0) return sd.Clients[0].Id;
  var cr = await fetch('https://api.mindbodyonline.com/public/v6/client/addclient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.MINDBODY_API_KEY, 'SiteId': process.env.MINDBODY_SITE_ID, 'Authorization': token },
    body: JSON.stringify({ FirstName: firstName, LastName: lastName, Email: email, MobilePhone: phone })
  });
  var cd = await cr.json();
  if (!cr.ok || !cd.Client) throw new Error('Failed to create Mindbody client: ' + JSON.stringify(cd));
  return cd.Client.Id;
}


async function getMindbodyToken() {
  try {
    var r = await fetch('https://api.mindbodyonline.com/public/v6/usertoken/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': process.env.MINDBODY_API_KEY, 'SiteId': process.env.MINDBODY_SITE_ID },
      body: JSON.stringify({ Username: process.env.MINDBODY_STAFF_USERNAME, Password: process.env.MINDBODY_STAFF_PASSWORD })
    });
    var d = await r.json();
    return d.AccessToken || null;
  } catch (err) {
    console.error('Mindbody token error:', err.message);
    return null;
  }
}


async function pushToGHL(firstName, lastName, email, phone, chamber, date, time, utms) {
  var contactBody = {
    firstName: firstName, lastName: lastName, email: email, phone: phone,
    tags: ['HBOT-Booking', 'Online-Booking', chamber + '-chamber'],
    source: 'Healthspan Booking Page',
    customFields: [
      { key: 'chamber_type', value: chamber },
      { key: 'booking_date', value: date },
      { key: 'booking_time', value: time }
    ]
  };
  if (process.env.GHL_LOCATION_ID) contactBody.locationId = process.env.GHL_LOCATION_ID;
  if (utms.utm_source) contactBody.customFields.push({ key: 'utm_source', value: utms.utm_source });
  if (utms.utm_medium) contactBody.customFields.push({ key: 'utm_medium', value: utms.utm_medium });
  if (utms.utm_campaign) contactBody.customFields.push({ key: 'utm_campaign', value: utms.utm_campaign });
  var resp = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.GHL_API_KEY, 'Content-Type': 'application/json', 'Version': '2021-07-28' },
    body: JSON.stringify(contactBody)
  });
  var result = await resp.json();
  if (!resp.ok) throw new Error('GHL error: ' + JSON.stringify(result));
  return result;
}
