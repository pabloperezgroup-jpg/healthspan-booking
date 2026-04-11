// Vercel Serverless Function: /api/get-availability
// Returns HBOT chamber availability by cross-referencing our schedule
// with existing Mindbody appointments (booked slots).
//
// Approach:
// 1. Start with hardcoded operating hours (weekday/friday/weekend)
// 2. Query Mindbody /appointment/staffappointments to get existing bookings
// 3. Mark any slot that matches a booked appointment as booked:true
// 4. Fall back to Supabase if Mindbody is unreachable

// Staff IDs (chambers set up as staff in Mindbody)
var STAFF_IDS = {
  soft: 100000015,  // HBOT 1(60m) = Soft Chamber
  hard: 100000027   // HBOT 2*    = Hard Chamber
};

// Operating hours (every hour, last slot = 60 min before close)
// Mon-Thu: 7 AM – 8 PM (last 60-min slot at 7 PM)
// Friday:  7 AM – 6 PM (last 60-min slot at 5 PM)
// Sat-Sun: 9 AM – 5 PM (last 60-min slot at 4 PM)
var SLOTS = {
  weekday: ['7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM'],
  friday:  ['7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'],
  weekend: ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM']
};

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { startDate, endDate, chamber } = req.query;

    // Default: today + 90 days
    if (!startDate) {
      var today = new Date();
      startDate = today.toISOString().split('T')[0];
    }
    if (!endDate) {
      var futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);
      endDate = futureDate.toISOString().split('T')[0];
    }

    // ── Step 1: Get Mindbody token ──
    var tokenResponse = await fetch('https://api.mindbodyonline.com/public/v6/usertoken/issue', {
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

    var tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.AccessToken) {
      console.error('Mindbody token error:', tokenData);
      return fallbackAvailability(req, res, startDate, endDate);
    }

    var accessToken = tokenData.AccessToken;
    var headers = {
      'Api-Key': process.env.MINDBODY_API_KEY,
      'SiteId': process.env.MINDBODY_SITE_ID,
      'Authorization': accessToken
    };

    // ── Step 2: Determine which staff (chamber) to query ──
    var staffIds = [];
    if (chamber === 'soft') {
      staffIds = [STAFF_IDS.soft];
    } else if (chamber === 'hard') {
      staffIds = [STAFF_IDS.hard];
    } else {
      staffIds = [STAFF_IDS.soft, STAFF_IDS.hard];
    }

    // ── Step 3: Query existing appointments from Mindbody ──
    // Store appointment time ranges so we can check overlaps (not just exact matches)
    // { "2026-04-12": [ { start: minutesSinceMidnight, end: minutesSinceMidnight }, ... ] }
    var bookedRanges = {};

    for (var i = 0; i < staffIds.length; i++) {
      var staffId = staffIds[i];
      var offset = 0;
      var hasMore = true;

      while (hasMore) {
        var params = new URLSearchParams({
          StartDate: startDate,
          EndDate: endDate,
          StaffIds: staffId.toString(),
          Limit: 200,
          Offset: offset
        });

        var apptResponse = await fetch(
          'https://api.mindbodyonline.com/public/v6/appointment/staffappointments?' + params.toString(),
          { method: 'GET', headers: headers }
        );

        // Handle non-JSON responses gracefully
        var apptText = await apptResponse.text();
        var apptData;
        try {
          apptData = JSON.parse(apptText);
        } catch(parseErr) {
          console.error('Mindbody appointments returned non-JSON:', apptText.substring(0, 200));
          break;
        }

        if (!apptResponse.ok) {
          console.error('Mindbody appointments error:', apptData);
          break;
        }

        var appointments = apptData.Appointments || apptData.StaffAppointments || [];

        appointments.forEach(function(appt) {
          // Only count confirmed/completed appointments, not cancelled
          if (appt.Status === 'Cancelled' || appt.Status === 'NoShow') return;
          if (!appt.StartDateTime || !appt.EndDateTime) return;

          var startDt = new Date(appt.StartDateTime);
          var endDt = new Date(appt.EndDateTime);
          var dateKey = startDt.toISOString().split('T')[0];

          // Store as minutes since midnight for easy overlap math
          var startMin = startDt.getHours() * 60 + startDt.getMinutes();
          var endMin = endDt.getHours() * 60 + endDt.getMinutes();

          if (!bookedRanges[dateKey]) bookedRanges[dateKey] = [];
          bookedRanges[dateKey].push({ start: startMin, end: endMin });
        });

        // Check if there are more pages
        var totalCount
