// api/freeze-membership.js
// Freezes a membership for one full calendar month.
// Rules: full month only (1st to last day), no mid-month, no limit on frequency.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId, targetMonth } = req.body; // targetMonth: "YYYY-MM" e.g. "2026-05"
  if (!memberId || !targetMonth) return res.status(400).json({ error: 'memberId and targetMonth required' });

  // Validate targetMonth format
  const [year, month] = targetMonth.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Invalid targetMonth format. Use YYYY-MM.' });
  }

  // Freeze window: 1st to last day of target month
  const freezeStart = new Date(year, month - 1, 1);
  const freezeEnd   = new Date(year, month, 0); // last day of month

  try {
    const { data: member, error } = await supabase
      .from('members')
      .select('*')
      .eq('id', memberId)
      .single();

    if (error || !member) return res.status(404).json({ error: 'Member not found' });
    if (member.status !== 'active') return res.status(400).json({ error: `Cannot freeze — membership is ${member.status}` });

    // Can't freeze a month already in the past
    const today = new Date();
    today.setHours(0,0,0,0);
    if (freezeEnd < today) return res.status(400).json({ error: 'Cannot freeze a month that has already passed' });

    // Pause Stripe subscription
    await stripe.subscriptions.update(member.stripe_subscription_id, {
      pause_collection: { behavior: 'void' }
    });

    // Update Supabase
    await supabase.from('members').update({
      status:      'frozen',
      freeze_start: freezeStart.toISOString().split('T')[0],
      freeze_end:   freezeEnd.toISOString().split('T')[0],
      freeze_count: (member.freeze_count || 0) + 1,
      updated_at:   new Date().toISOString()
    }).eq('id', memberId);

    // Log activity
    await supabase.from('member_activity').insert({
      member_id:   memberId,
      action:      'freeze',
      details:     { freeze_start: freezeStart.toISOString().split('T')[0], freeze_end: freezeEnd.toISOString().split('T')[0] },
      performed_by: 'member'
    });

    // Send confirmation email
    const monthLabel = freezeStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    await resend.emails.send({
      from:    'Healthspan <noreply@healthspanrecovery.com>',
      to:      member.email,
      subject: `Membership frozen for ${monthLabel}`,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;color:#0D1B2A;">
          <div style="background:#0D1B2A;padding:20px 24px;border-radius:12px 12px 0 0;"><h1 style="color:white;margin:0;font-size:20px;font-weight:800;">Healthspan</h1></div>
          <div style="background:white;padding:28px;border-radius:0 0 12px 12px;border:1px solid #E8EAED;">
            <p style="font-size:18px;font-weight:800;margin:0 0 8px;">Membership frozen ✋</p>
            <p style="color:#6B7280;line-height:1.6;margin:0 0 16px;">Hi ${member.first_name}, your membership is frozen for <strong>${monthLabel}</strong>. You won't be charged during this period.</p>
            <div style="background:#F7F8F9;border-radius:10px;padding:14px;margin-bottom:16px;font-size:14px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:#6B7280;">Frozen period</span><span style="font-weight:700;">${monthLabel}</span></div>
              <div style="display:flex;justify-content:space-between;"><span style="color:#6B7280;">Resumes</span><span style="font-weight:700;">Automatically on ${freezeEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
            </div>
            <p style="color:#6B7280;font-size:13px;">You can unfreeze early anytime from your <a href="${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal" style="color:#0A7C6B;">member portal</a>.</p>
          </div>
        </div>
      `
    });

    return res.json({ success: true, freeze_start: freezeStart.toISOString().split('T')[0], freeze_end: freezeEnd.toISOString().split('T')[0] });

  } catch (err) {
    console.error('freeze-membership error:', err);
    return res.status(500).json({ error: err.message });
  }
};
