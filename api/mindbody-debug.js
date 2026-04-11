// Temporary diagnostic endpoint — v2
// Shows raw response from Mindbody appointments endpoint
// DELETE THIS FILE after debugging is complete

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var results = { env: {}, token: null, staff: null, appointmentsRaw: null };

  // Check which env vars are set (don't reveal values)
  results.env = {
    MINDBODY_API_KEY: !!process.env.MINDBODY_API_KEY,
    MINDBODY_SITE_ID: !!process.env.MINDBODY_SITE_ID,
    MINDBODY_STAFF_USERNAME: !!process.env.MINDBODY_STAFF_USERNAME,
    MINDBODY_STAFF_PASSWORD: !!process.env.MINDBODY_STAFF_PASSWORD,
    SITE_ID_VALUE: process.env.MINDBODY_SITE_ID || 'NOT SET'
  };

  try {
    // Step 1: Get token
    var tokenRes = await fetch('https://api.mindbodyonline.com/public/v6/usertoken/issue', {
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
    var tokenData = await tokenRes.json();
    results.token = {
      ok: tokenRes.ok,
      status: tokenRes.status,
      hasAccessToken: !!tokenData.AccessToken,
      error: tokenData.Error || null
    };

    if (!tokenData.AccessToken) {
      return res.status(200).json(results);
    }

    var headers = {
      'Api-Key': process.env.MINDBODY_API_KEY,
      'SiteId': process.env.MINDBODY_SITE_ID,
      'Authorization': tokenData.AccessToken
    };

    // Step 2: Quick staff check (this works)
    try {
      var staffRes = await fetch('https://api.mindbodyonline.com/public/v6/staff/staff?Limit=5', {
        headers: headers
      });
      var staffData = await staffRes.json();
      results.staff = {
        ok: staffRes.ok,
        status: staffRes.status,
        count: (staffData.StaffMembers || []).length
      };
    } catch(e) {
      results.staff = { error: e.message };
    }

    // Step 3: Appointments — capture RAW response text + status
    try {
      var tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      var apptDate = tomorrow.toISOString().split('T')[0];

      // Try WITHOUT StaffIds first (simplest call)
      var url1 = 'https://api.mindbodyonline.com/public/v6/appointment/appointments?StartDate=' + apptDate + '&EndDate=' + apptDate;
      var apptRes1 = await fetch(url1, { headers: headers });
      var rawText1 = await apptRes1.text();

      results.appointmentsRaw = {
        url: url1,
        httpStatus: apptRes1.status,
        httpStatusText: apptRes1.statusText,
        contentType: apptRes1.headers.get('content-type'),
        rawFirst500: rawText1.substring(0, 500),
        isJSON: rawText1.trim().startsWith('{') || rawText1.trim().startsWith('[')
      };

      // If that worked as JSON, parse it
      if (results.appointmentsRaw.isJSON) {
        try {
          var parsed = JSON.parse(rawText1);
          results.appointmentsRaw.parsed = {
            appointmentCount: (parsed.Appointments || []).length,
            first2: (parsed.Appointments || []).slice(0, 2).map(function(a) {
              return {
                Id: a.Id,
                StartDateTime: a.StartDateTime,
                Status: a.Status,
                Staff: a.Staff ? { Id: a.Staff.Id, Name: a.Staff.DisplayName } : null
              };
            }),
            errorMessage: parsed.Error || null
          };
        } catch(pe) {
          results.appointmentsRaw.parseError = pe.message;
        }
      }

      // Step 4: Also try WITH StaffIds for soft chamber
      var url2 = 'https://api.mindbodyonline.com/public/v6/appointment/appointments?StartDate=' + apptDate + '&EndDate=' + apptDate + '&StaffIds=100000015';
      var apptRes2 = await fetch(url2, { headers: headers });
      var rawText2 = await apptRes2.text();

      results.appointmentsWithStaff = {
        url: url2,
        httpStatus: apptRes2.status,
        httpStatusText: apptRes2.statusText,
        rawFirst500: rawText2.substring(0, 500),
        isJSON: rawText2.trim().startsWith('{') || rawText2.trim().startsWith('[')
      };

      if (results.appointmentsWithStaff.isJSON) {
        try {
          var parsed2 = JSON.parse(rawText2);
          results.appointmentsWithStaff.parsed = {
            appointmentCount: (parsed2.Appointments || []).length,
            first2: (parsed2.Appointments || []).slice(0, 2).map(function(a) {
              return {
                Id: a.Id,
                StartDateTime: a.StartDateTime,
                Status: a.Status,
                Staff: a.Staff ? { Id: a.Staff.Id, Name: a.Staff.DisplayName } : null
              };
            }),
            errorMessage: parsed2.Error || null
          };
        } catch(pe2) {
          results.appointmentsWithStaff.parseError = pe2.message;
        }
      }

    } catch(e) {
      results.appointmentsRaw = { fatalError: e.message };
    }

  } catch(err) {
    results.fatalError = err.message;
  }

  return res.status(200).json(results);
};
