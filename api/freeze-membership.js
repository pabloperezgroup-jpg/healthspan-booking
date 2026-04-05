// Vercel Serverless Function: /api/unfreeze-membership
// Resumes a frozen Stripe subscription and updates Supabase.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { email } = req.body;

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

    if (member.status !== 'frozen') {
      return res.status(400).json({ error: 'Membership is not currently frozen' });
    }

    if (!member.stripe_subscription_id) {
      return res.status(400).json({ error: 'No subscription found' });
    }

    // Resume the Stripe subscription (remove pause_collection)
    await stripe.subscriptions.update(member.stripe_subscription_id, {
      pause_collection: ''
    });

    // Update Supabase
    var { error: updateErr } = await supabase
      .from('members')
      .update({
        status: 'active',
        freeze_start: null,
        freeze_end: new Date().toISOString()
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
        action: 'unfreeze',
        details: JSON.stringify({ resumed_at: new Date().toISOString() })
      });
    } catch (logErr) {
      console.error('Activity log error:', logErr);
    }

    return res.status(200).json({
      success: true,
      status: 'active',
      message: 'Membership reactivated. Regular billing will resume.'
    });

  } catch (err) {
    console.error('unfreeze-membership error:', err);
    return res.status(500).json({ error: err.message || 'Failed to unfreeze membe
