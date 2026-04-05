// Vercel Serverless Function: /api/cancel-membership
// Cancels a member's subscription at end of current billing period.
// Updates Supabase status to 'cancelled'.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { email, reason } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    var normalizedEmail = email.toLowerCase().trim();
    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Look up member
    var { data: member, error: lookupErr } = await supabase
      .from('members')
      .select('*')
      .eq('email', normalizedEmail)
      .single();

    if (lookupErr || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (member.status === 'cancelled') {
      return res.status(400).json({ error: 'Membership is already cancelled' });
    }

    if (!member.stripe_subscription_id) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Cancel at end of current period (not immediately)
    var subscription = await stripe.subscriptions.update(member.stripe_subscription_id, {
      cancel_at_period_end: true,
      metadata: { cancellation_reason: reason || 'Member requested cancellation' }
    });

    var cancelDate = new Date(subscription.current_period_end * 1000).toISOString();

    // Update Supabase
    var { error: updateErr } = await supabase
      .from('members')
      .update({
        status: 'cancelled',
        cancel_requested_at: new Date().toISOString(),
        cancellation_reason: reason || null,
        cancel_effective_date: cancelDate
      })
      .eq('email', normalizedEmail);

    if (updateErr) {
      console.error('Supabase update error:', updateErr);
    }

    // Log activity
    try {
      await supabase.from('member_activity').insert({
        member_id: member.id,
        email: normalizedEmail,
        action: 'cancel',
        details: JSON.stringify({
          reason: reason || 'Member requested cancellation',
          effective_date: cancelDate
        })
      });
    } catch (logErr) {
      console.error('Activity log error:', logErr);
    }

    return res.status(200).json({
      success: true,
      status: 'cancelled',
      effectiveDate: cancelDate,
      message: 'Membership will end at the end of the current billing period. You can still use services until then.'
    });

  } catch (err) {
    console.error('cancel-membership error:', err);
    return res.status(500).json({ error: err.message || 'Failed to cancel membershi
