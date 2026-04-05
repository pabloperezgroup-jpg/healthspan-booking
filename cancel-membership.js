// api/cancel-membership.js
// Cancels a membership at end of current billing period.
// Member keeps full access until their last paid day.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend   = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { memberId, reason } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId required' });

  const { data: member } = await supabase.from('members').select('*').eq('id', memberId).single();
  if (!member) return res.status(404).json({ error: 'Member not found' });
  if (!['active', 'frozen'].includes(member.status)) {
    return res.status(400).json({ error: 'Membership is already cancelled or expired' });
  }

  try {
    // Cancel Stripe subscription at period end (member keeps access)
    await stripe.subscriptions.update(member.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    // Effective date = current_period_end (last day they've paid for)
    const effectiveDate = member.current_period_end || member.next_billing_date;

    await supabase.from('members').update({
      cancel_requested_at:   new Date().toISOString(),
      cancel_effective_date: effectiveDate,
      cancellation_reason:   reason || null,
      updated_at:            new Date().toISOString()
      // Status stays 'active' until effective date — a nightly job/webhook updates to 'cancelled'
    }).eq('id', memberId);

    await supabase.from('member_activity').insert({
      member_id:    memberId,
      action:       'cancel',
      details:      { effective_date: effectiveDate, reason: reason || null },
      performed_by: 'member'
    });

    const effectiveLabel = effectiveDate
      ? new Date(effectiveDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'end of billing period';

    await resend.emails.send({
      from:    'Healthspan <noreply@healthspanrecovery.com>',
      to:      member.email,
      subject: 'Your Healthspan membership cancellation',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#0D1B2A;padding:20px 24px;border-radius:12px 12px 0 0;"><h1 style="color:white;margin:0;font-size:20px;font-weight:800;">Healthspan</h1></div>
          <div style="background:white;padding:28px;border-radius:0 0 12px 12px;border:1px solid #E8EAED;">
            <p style="font-size:18px;font-weight:800;margin:0 0 8px;">Membership cancellation confirmed</p>
            <p style="color:#6B7280;line-height:1.6;margin:0 0 16px;">Hi ${member.first_name}, your cancellation is confirmed. You have full access to Healthspan through <strong>${effectiveLabel}</strong> — no refund or proration applies.</p>
            <div style="background:#FFF7ED;border-radius:10px;padding:14px;margin-bottom:16px;font-size:14px;border-left:3px solid #F59E0B;">
              <strong>Access ends:</strong> ${effectiveLabel}<br/>
              <span style="color:#6B7280;font-size:13px;">No further charges will be made after this date.</span>
            </div>
            <p style="color:#6B7280;font-size:13px;margin-bottom:16px;">We're sorry to see you go. If you ever want to return, rejoining is quick and easy — and you'll always be treated as family.</p>
            <p style="color:#6B7280;font-size:12px;">Changed your mind? <a href="${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal" style="color:#0A7C6B;">Reactivate your membership</a> before ${effectiveLabel}.</p>
          </div>
        </div>
      `
    });

    return res.json({ success: true, cancel_effective_date: effectiveDate });

  } catch (err) {
    console.error('cancel-membership error:', err);
    return res.status(500).json({ error: err.message });
  }
};
