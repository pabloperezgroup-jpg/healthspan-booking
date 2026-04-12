// Vercel Serverless Function: /api/capture-lead
// Captures contact info when a prospect fills in Step 4 (Your Info)
// but hasn't paid yet. If they complete payment, book-session.js
// handles the full booking — this just catches the ones who drop off.
//
// Saves to Supabase "leads" table and pushes to GHL with
// "Abandoned-Booking" tag for follow-up automation.

var { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { firstName, lastName, email, phone, chamber, date, time,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term } = req.body;

    // Validate minimum required fields
    if (!email || !firstName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    var normalizedEmail = email.toLowerCase().trim();

    // ── Save to Supabase ──
    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    var leadRecord = {
      first_name: firstName.trim(),
      last_name: (lastName || '').trim(),
      email: normalizedEmail,
      phone: (phone || '').trim(),
      chamber_type: chamber || null,
      interested_date: date || null,
      interested_time: time || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      utm_term: utm_term || null,
      status: 'abandoned',
      captured_at: new Date().toISOString()
    };

    // Upsert by email — if the same person comes back, update their record
    // instead of creating duplicates
    var { error: dbError } = await supabase
      .from('leads')
      .upsert(leadRecord, { onConflict: 'email' });

    if (dbError) {
      console.error('Supabase lead insert error:', dbError);
      // Don't fail — still try GHL
    }

    // ── Push to GHL ──
    pushToGHL(firstName.trim(), (lastName || '').trim(), normalizedEmail, (phone || '').trim(), chamber, date, time, {
      utm_source: utm_source, utm_medium: utm_medium,
      utm_campaign: utm_campaign, utm_content: utm_content, utm_term: utm_term
    }).catch(function(err) {
      console.error('GHL lead push error:', err.message);
    });

    return res.status(200).json({ captured: true });

  } catch (err) {
    console.error('capture-lead error:', err);
    return res.status(500).json({ error: 'Failed to capture lead' });
  }
};


// ── GHL: Push lead with Abandoned-Booking tag ──
async function pushToGHL(firstName, lastName, email, phone, chamber, date, time, utms) {
  if (!process.env.GHL_API_KEY) return;

  var locationId = process.env.GHL_LOCATION_ID;

  var contactBody = {
    firstName: firstName,
    lastName: lastName,
    email: email,
    phone: phone,
    tags: ['Abandoned-Booking', chamber ? chamber + '-chamber' : 'unknown-chamber'],
    source: 'Healthspan Booking Page',
    customFields: []
  };

  if (locationId) contactBody.locationId = locationId;
  if (chamber) contactBody.customFields.push({ key: 'chamber_type', value: chamber });
  if (date) contactBody.customFields.push({ key: 'interested_date', value: date });
  if (time) contactBody.customFields.push({ key: 'interested_time', value: time });
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
