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

// Operating hours
var SLOTS = {
  weekday: ['7:00 AM','9:00 AM','11:00 AM','1:00 PM','3:00 PM','5:00 PM','7:00 PM'],
  friday:  ['7:00 AM','9:00 AM','11:00 AM','1:00 PM','3:00 PM','4:00 PM','5:00 PM'],
  weekend: ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM']
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
    // Fetch appointments for each staff/chamber
    var bookedSlots = {}; // { "2026-04-12": ["9:00 AM", "1:00 PM"], ... }

    // Mindbody limits date ranges, so query in chunks if needed
    // For now, query all at once (works for reasonable ranges)
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
          if (!appt.StartDateTime) return;

          var dt = new Date(appt.StartDateTime);
          var dateKey = dt.toISOString().split('T')[0];
          var timeStr = formatTime(dt);

          if (!bookedSlots[dateKey]) bookedSlots[dateKey] = [];
          if (!bookedSlots[dateKey].includes(timeStr)) {
            bookedSlots[dateKey].push(timeStr);
          }
        });

        // Check if there are more pages
        var totalCount = apptData.PaginationResponse ? apptData.PaginationResponse.TotalResults : 0;
        offset += appointments.length;
        hasMore = offset < totalCount && appointments.length > 0;
      }
    }

    // ── Step 4: Build availability by merging schedule with booked slots ──
    var availability = {};
    var current = new Date(startDate + 'T00:00:00');
    var end = new Date(endDate + 'T00:00:00');

    while (current <= end) {
      var dateKey = current.toISOString().split('T')[0];
      var dayOfWeek = current.getDay();

      // Get base schedule for this day type
      var base;
      if (dayOfWeek === 0 || dayOfWeek === 6) base = SLOTS.weekend;
      else if (dayOfWeek === 5) base = SLOTS.friday;
      else base = SLOTS.weekday;

      var dateBooked = bookedSlots[dateKey] || [];

      availability[dateKey] = base.map(function(time) {
        return {
          time: time,
          booked: dateBooked.includes(time)
        };
      });

      current.setDate(current.getDate() + 1);
    }

    var bookedCount = Object.values(bookedSlots).reduce(function(sum, arr) { return sum + arr.length; }, 0);
    console.log('Mindbody: found ' + bookedCount + ' booked slots across ' + Object.keys(bookedSlots).length + ' dates');

    return res.status(200).json({
      source: 'mindbody',
      startDate: startDate,
      endDate: endDate,
      chamber: chamber || 'all',
      bookedCount: bookedCount,
      availability: availability
    });

  } catch (err) {
    console.error('get-availability error:', err);
    return fallbackAvailability(req, res, req.query.startDate, req.query.endDate);
  }
};


// ── Helper: format Date to "H:MM AM/PM" ──
function formatTime(dt) {
  var hours = dt.getHours();
  var minutes = dt.getMinutes();
  var ampm = hours >= 12 ? 'PM' : 'AM';
  var displayHours = hours % 12 || 12;
  var displayMinutes = minutes === 0 ? '00' : String(minutes).padStart(2, '0');
  return displayHours + ':' + displayMinutes + ' ' + ampm;
}


// ── Fallback: Supabase-based availability if Mindbody is down ──
async function fallbackAvailability(req, res, startDate, endDate) {
  try {
    var { createClient } = require('@supabase/supabase-js');
    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    var [{ data: overrides }, { data: bookings }] = await Promise.all([
      supabase.from('availability_overrides').select('slot_date,slot_time,is_open')
        .gte('slot_date', startDate).lte('slot_date', endDate),
      supabase.from('bookings').select('booking_date,booking_time')
        .gte('booking_date', startDate).eq('status', 'confirmed')
    ]);

    var overrideMap = {};
    (overrides || []).forEach(function(r) {
      if (!overrideMap[r.slot_date]) overrideMap[r.slot_date] = {};
      overrideMap[r.slot_date][r.slot_time] = r.is_open;
    });

    var bookedMap = {};
    (bookings || []).forEach(function(b) {
      if (!bookedMap[b.booking_date]) bookedMap[b.booking_date] = [];
      bookedMap[b.booking_date].push(b.booking_time);
    });

    var availability = {};
    var current = new Date(startDate + 'T00:00:00');
    var end = new Date(endDate + 'T00:00:00');

    while (current <= end) {
      var dateKey = current.toISOString().split('T')[0];
      var dayOfWeek = current.getDay();

      // Sundays and Saturdays use weekend hours
      var base;
      if (dayOfWeek === 0 || dayOfWeek === 6) base = SLOTS.weekend;
      else if (dayOfWeek === 5) base = SLOTS.friday;
      else base = SLOTS.weekday;

      var dateOverrides = overrideMap[dateKey] || {};
      var dateBooked = bookedMap[dateKey] || [];

      availability[dateKey] = base.map(function(time) {
        var isBooked = dateBooked.includes(time);
        var override = dateOverrides[time];
        if (override === false) return { time: time, booked: true };
        if (override === true) return { time: time, booked: false };
        return { time: time, booked: isBooked };
      });

      current.setDate(current.getDate() + 1);
    }

    return res.status(200).json({
      source: 'fallback',
      startDate: startDate,
      endDate: endDate,
      availability: availability
    });

  } catch (fallbackErr) {
    console.error('Fallback availability error:', fallbackErr);
    return res.status(500).json({ error: 'Unable to load availability' });
  }
}
