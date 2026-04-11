// Temporary diagnostic endpoint — v2
// Shows raw response from Mindbody staffappointments endpoint
// DELETE THIS FILE after debugging is complete

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var results = { env: {}, token: null, staff: null, appointmentsRaw: null };

  results.env = {
    MINDBODY_API_KEY: !!process.env.MINDBODY_API_KEY,
    MINDBODY_SITE_ID: !!process.env.MINDBODY_SITE_ID,
    MINDBODY_STAFF_USERNAME: !!process.env.MINDBODY_STAFF_USERNAME,
    MINDBODY_STAFF_PASSWORD: !!process.env.MINDBODY_STAFF_PASSWORD,
    SITE_ID_VALUE: process.env.MINDBODY_SITE_ID || 'NOT SET'
  };

  try {
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

    try {
      var tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      var apptDate = tomorrow.toISOString().split('T')[0];

      var url1 = 'https://api.mindbodyonline.com/public/v6/appointment/staffappointments?StartDate=' + apptDate + '&EndDate=' + apptDate;
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

      if (results.appointmentsRaw.isJSON) {
        try {
          var parsed = JSON.parse(rawText1);
          results.appointmentsRaw.parsed = {
            keys: Object.keys(parsed),
            appointmentCount: (parsed.Appointments || parsed.StaffAppointments || []).length,
            first2: (parsed.Appointments || parsed.StaffAppointments || []).slice(0, 2).map(function(a) {
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

      var url2 = 'https://api.mindbodyonline.com/public/v6/appointment/staffappointments?StartDate=' + apptDate + '&EndDate=' + apptDate + '&StaffIds=100000015';
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
            keys: Object.keys(parsed2),
            appointmentCount: (parsed2.Appointments || parsed2.StaffAppointments || []).length,
            first2: (parsed2.Appointments || parsed2.StaffAppointments || []).slice(0, 2).map(function(a) {
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
