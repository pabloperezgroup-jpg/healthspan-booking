// api/unfreeze-membership.js — Member taps "Unfreeze" in portal to resume early.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const { data: member } = await supabase.from('members').select('*').eq('id', memberId).single();
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (member.status !== 'frozen') return res.status(400).json({ error: 'Membership is not frozen' });

  try {
    // Resume Stripe subscription
    await stripe.subscriptions.update(member.stripe_subscription_id, {
      pause_collection: ''
    });

    await supabase.from('members').update({
      status:      'active',
      freeze_start: null,
      freeze_end:   null,
      updated_at:   new Date().toISOString()
    }).eq('id', memberId);

    await supabase.from('member_activity').insert({
      member_id:   memberId,
      action:      'unfreeze',
      details:     { unfrozen_on: new Date().toISOString().split('T')[0] },
      performed_by: 'member'
    });

    await resend.emails.send({
      from:    'Healthspan <noreply@healthspanrecovery.com>',
      to:      member.email,
      subject: 'Your membership is active again!',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#0D1B2A;padding:20px 24px;border-radius:12px 12px 0 0;"><h1 style="color:white;margin:0;font-size:20px;font-weight:800;">Healthspan</h1></div>
          <div style="background:white;padding:28px;border-radius:0 0 12px 12px;border:1px solid #E8EAED;">
            <p style="font-size:18px;font-weight:800;margin:0 0 8px;">Welcome back, ${member.first_name}! 🎉</p>
            <p style="color:#6B7280;line-height:1.6;margin:0 0 20px;">Your membership is active again. Book your next session from your portal — we can't wait to see you.</p>
            <a href="${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal" style="display:block;background:#0A7C6B;color:white;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:800;">Book My Next Session →</a>
          </div>
        </div>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('unfreeze error:', err);
    return res.status(500).json({ error: err.message });
  }
};
