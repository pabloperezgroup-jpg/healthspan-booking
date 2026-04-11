// Vercel Serverless Function: /api/get-availability
// Pulls real-time HBOT chamber availability from Mindbody API v6.
// Returns available time slots for a given date range and chamber type.

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { startDate, endDate, chamber } = req.query;

    if (!startDate) {
      var today = new Date();
      startDate = today.toISOString().split('T')[0];
    }
    if (!endDate) {
      var futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 90);
      endDate = futureDate.toISOString().split('T')[0];
    }

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

    var params = new URLSearchParams({
      StartDate: startDate,
      EndDate: endDate,
      Limit: 200
    });

    if (chamber === 'soft' && process.env.MINDBODY_HBOT_SOFT_SESSION_TYPE_ID) {
      params.append('SessionTypeIds', process.env.MINDBODY_HBOT_SOFT_SESSION_TYPE_ID);
    } else if (chamber === 'hard' && process.env.MINDBODY_HBOT_HARD_SESSION_TYPE_ID) {
      params.append('SessionTypeIds', process.env.MINDBODY_HBOT_HARD_SESSION_TYPE_ID);
    }

    var availResponse = await fetch(
      'https://api.mindbodyonline.com/public/v6/appointment/bookableitems?' + params.toString(),
      {
        method: 'GET',
        headers: {
          'Api-Key': process.env.MINDBODY_API_KEY,
          'SiteId': process.env.MINDBODY_SITE_ID,
          'Authorization': accessToken
        }
      }
    );

    var availData = await availResponse.json();

    if (!availResponse.ok) {
      console.error('Mindbody availability error:', availData);
      return fallbackAvailability(req, res, startDate, endDate);
    }

    var slotsByDate = {};

    var items = availData.BookableItems || availData.AvailableItems || [];
    items.forEach(function(item) {
      if (!item.StartDateTime) return;

      var dt = new Date(item.StartDateTime);
      var dateKey = dt.toISOString().split('T')[0];

      var hours = dt.getHours();
      var minutes = dt.getMinutes();
      var ampm = hours >= 12 ? 'PM' : 'AM';
      var displayHours = hours % 12 || 12;
      var displayMinutes = minutes === 0 ? '00' : String(minutes).padStart(2, '0');
      var timeStr = displayHours + ':' + displayMinutes + ' ' + ampm;

      if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];

      var exists = slotsByDate[dateKey].some(function(s) { return s.time === timeStr; });
      if (!exists) {
        slotsByDate[dateKey].push({
          time: timeStr,
          booked: false,
          staffId: item.Staff ? item.Staff.Id : null,
          staffName: item.Staff ? item.Staff.DisplayName : null,
          sessionTypeId: item.SessionType ? item.SessionType.Id : null,
          mindbodyId: item.Id || null
        });
      }
    });

    Object.keys(slotsByDate).forEach(function(dateKey) {
      slotsByDate[dateKey].sort(function(a, b) {
        return parseTime(a.time) - parseTime(b.time);
      });
    });

    return res.status(200).json({
      source: 'mindbody',
      startDate: startDate,
      endDate: endDate,
      chamber: chamber || 'all',
      availability: slotsByDate
    });

  } catch (err) {
    console.error('get-availability error:', err);
    return fallbackAvailability(req, res, req.query.startDate, req.query.endDate);
  }
};


function parseTime(timeStr) {
  var parts = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!parts) return 0;
  var h = parseInt(parts[1], 10);
  var m = parseInt(parts[2], 10);
  var ampm = parts[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}


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

    var SLOTS = {
      weekday: ['7:00 AM','9:00 AM','11:00 AM','1:00 PM','3:00 PM','5:00 PM','7:00 PM'],
      friday:  ['7:00 AM','9:00 AM','11:00 AM','1:00 PM','3:00 PM','4:00 PM','5:00 PM'],
      weekend: ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM']
    };

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

      if (dayOfWeek !== 0) {
        var base;
        if (dayOfWeek === 6) base = SLOTS.weekend;
        else if (dayOfWeek === 5) base = SLOTS.friday;
        else base = SLOTS.weekday;

        var dateOverrides = overrideMap[dateKey] || {};
        var dateBooked = bookedMap[dateKey] || [];

        var slots = base.map(function(time) {
          var isBooked = dateBooked.includes(time);
          var override = dateOverrides[time];
          if (override === false) return { time: time, booked: true };
          if (override === true) return { time: time, booked: false };
          return { time: time, booked: isBooked };
        }).filter(function(s) { return !s.booked; });

        if (slots.length > 0) {
          availability[dateKey] = slots;
        }
      }

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
