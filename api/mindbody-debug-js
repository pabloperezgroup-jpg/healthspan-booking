// Temporary diagnostic endpoint — pulls session types, staff, and bookable items from Mindbody
// DELETE THIS FILE after we find the right IDs

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var results = { env: {}, token: null, sessionTypes: null, staff: null, bookableItems: null, appointments: null };

  // Check which env vars are set (don't reveal values)
  results.env = {
    MINDBODY_API_KEY: !!process.env.MINDBODY_API_KEY,
    MINDBODY_SITE_ID: !!process.env.MINDBODY_SITE_ID,
    MINDBODY_STAFF_USERNAME: !!process.env.MINDBODY_STAFF_USERNAME,
    MINDBODY_STAFF_PASSWORD: !!process.env.MINDBODY_STAFF_PASSWORD,
    MINDBODY_HBOT_SOFT_SESSION_TYPE_ID: process.env.MINDBODY_HBOT_SOFT_SESSION_TYPE_ID || 'NOT SET',
    MINDBODY_HBOT_HARD_SESSION_TYPE_ID: process.env.MINDBODY_HBOT_HARD_SESSION_TYPE_ID || 'NOT SET',
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

    // Step 2: Get all session types
    try {
      var stRes = await fetch('https://api.mindbodyonline.com/public/v6/appointment/sessiontypes', {
        headers: headers
      });
      var stData = await stRes.json();
      results.sessionTypes = {
        ok: stRes.ok,
        count: (stData.SessionTypes || []).length,
        types: (stData.SessionTypes || []).map(function(t) {
          return { Id: t.Id, Name: t.Name, NumDeducted: t.NumDeducted, ProgramId: t.ProgramId };
        })
      };
    } catch(e) {
      results.sessionTypes = { error: e.message };
    }

    // Step 3: Get all staff (these are your chambers)
    try {
      var staffRes = await fetch('https://api.mindbodyonline.com/public/v6/staff/staff?Limit=100', {
        headers: headers
      });
      var staffData = await staffRes.json();
      results.staff = {
        ok: staffRes.ok,
        count: (staffData.StaffMembers || []).length,
        members: (staffData.StaffMembers || []).map(function(s) {
          return { Id: s.Id, DisplayName: s.DisplayName, FirstName: s.FirstName, LastName: s.LastName, isMale: s.isMale };
        })
      };
    } catch(e) {
      results.staff = { error: e.message };
    }

    // Step 4: Try bookable items for tomorrow
    try {
      var tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      var startDate = tomorrow.toISOString().split('T')[0];
      var endDate = startDate;

      var biRes = await fetch(
        'https://api.mindbodyonline.com/public/v6/appointment/bookableitems?StartDate=' + startDate + '&EndDate=' + endDate + '&Limit=200',
        { headers: headers }
      );
      var biData = await biRes.json();
      var items = biData.BookableItems || biData.AvailableItems || [];
      results.bookableItems = {
        ok: biRes.ok,
        status: biRes.status,
        count: items.length,
        rawKeys: Object.keys(biData),
        first3: items.slice(0, 3).map(function(item) {
          return {
            Id: item.Id,
            StartDateTime: item.StartDateTime,
            EndDateTime: item.EndDateTime,
            Staff: item.Staff ? { Id: item.Staff.Id, Name: item.Staff.DisplayName } : null,
            SessionType: item.SessionType ? { Id: item.SessionType.Id, Name: item.SessionType.Name } : null,
            Location: item.Location ? { Id: item.Location.Id, Name: item.Location.Name } : null
          };
        }),
        errorMessage: biData.Error || null
      };
    } catch(e) {
      results.bookableItems = { error: e.message };
    }

    // Step 5: Try scheduled appointments (already booked)
    try {
      var tomorrow2 = new Date();
      tomorrow2.setDate(tomorrow2.getDate() + 1);
      var apptDate = tomorrow2.toISOString().split('T')[0];

      var apptRes = await fetch(
        'https://api.mindbodyonline.com/public/v6/appointment/appointments?StartDate=' + apptDate + '&EndDate=' + apptDate,
        { headers: headers }
      );
      var apptData = await apptRes.json();
      var appts = apptData.Appointments || [];
      results.appointments = {
        ok: apptRes.ok,
        count: appts.length,
        first3: appts.slice(0, 3).map(function(a) {
          return {
            Id: a.Id,
            StartDateTime: a.StartDateTime,
            EndDateTime: a.EndDateTime,
            Status: a.Status,
            Staff: a.Staff ? { Id: a.Staff.Id, Name: a.Staff.DisplayName } : null,
            SessionType: a.SessionType ? { Id: a.SessionType.Id, Name: a.SessionType.Name } : null,
            Client: a.Client ? { Id: a.Client.Id, FirstName: a.Client.FirstName } : null
          };
        })
      };
    } catch(e) {
      results.appointments = { error: e.message };
    }

  } catch(err) {
    results.fatalError = err.message;
  }

  return res.status(200).json(results);
};
