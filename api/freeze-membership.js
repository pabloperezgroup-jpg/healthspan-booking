// Vercel Serverless Function: /api/freeze-membership
// Pauses a member's Stripe subscription and updates Supabase status.

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

    if (member.status === 'frozen') {
      return res.status(400).json({ error: 'Membership is already frozen' });
    }

    if (!member.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Pause the Stripe subscription
    await stripe.subscriptions.update(member.stripe_subscription_id, {
      pause_collection: { behavior: 'void' },
      metadata: { freeze_reason: reason || 'Member requested freeze' }
    });

    // Update Supabase
    var { error: updateErr } = await supabase
      .from('members')
      .update({
        status: 'frozen',
        freeze_start: new Date().toISOString()
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
        action: 'freeze',
        details: JSON.stringify({ reason: reason || 'Member requested freeze' })
      });
    } catch (logErr) {
      console.error('Activity log error:', logErr);
    }

    return res.status(200).json({
      success: true,
      status: 'frozen',
      message: 'Membership frozen successfully. No charges will be made until unfrozen.'
    });

  } catch (err) {
    console.error('freeze-membership error:', err);
    return res.status(500).json({ error: err.message || 'Failed to freeze membership' });
  }
};
