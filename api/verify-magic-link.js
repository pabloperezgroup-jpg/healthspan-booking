// api/verify-magic-link.js
// Validates a magic link token and returns full member data.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { data: link, error } = await supabase
    .from('magic_links')
    .select('*, members(*)')
    .eq('token', token)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (error || !link) {
    return res.status(401).json({ error: 'This link has expired or already been used. Please request a new one.' });
  }

  // Mark token as used
  await supabase
    .from('magic_links')
    .update({ used_at: new Date().toISOString() })
    .eq('id', link.id);

  const member = link.members;

  // Get today's session count
  const today = new Date().toISOString().split('T')[0];
  const { count: todaySessions } = await supabase
    .from('bookings')
    .select('*', { count: 'exact', head: true })
    .eq('email', member.email)
    .eq('booking_date', today)
    .eq('status', 'confirmed');

  return res.json({
    success: true,
    member: {
      id:                  member.id,
      first_name:          member.first_name,
      last_name:           member.last_name,
      email:               member.email,
      phone:               member.phone,
      plan_type:           member.plan_type,
      status:              member.status,
      next_billing_date:   member.next_billing_date,
      monthly_amount_cents:member.monthly_amount_cents,
      freeze_start:        member.freeze_start,
      freeze_end:          member.freeze_end,
      freeze_count:        member.freeze_count,
      cancel_effective_date: member.cancel_effective_date,
      today_sessions:      todaySessions || 0
    }
  });
};
