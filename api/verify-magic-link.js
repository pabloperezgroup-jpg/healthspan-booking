// Vercel Serverless Function: /api/verify-magic-link
// Verifies a magic link token and returns member data if valid.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Look up the magic link
    var { data: link, error: linkErr } = await supabase
      .from('magic_links')
      .select('*')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (linkErr || !link) {
      return res.status(401).json({ error: 'Invalid or expired login link' });
    }

    // Check if expired
    if (new Date(link.expires_at) < new Date()) {
      // Mark as used so it can't be retried
      await supabase.from('magic_links').update({ used: true }).eq('id', link.id);
      return res.status(401).json({ error: 'This login link has expired. Please request a new one.' });
    }

    // Mark token as used (one-time use)
    await supabase.from('magic_links').update({ used: true }).eq('id', link.id);

    // Get member data
    var { data: member, error: memberErr } = await supabase
      .from('members')
      .select('*')
      .eq('email', link.email)
      .single();

    if (memberErr || !member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Return member data (excluding sensitive fields)
    return res.status(200).json({
      success: true,
      member: {
        id: member.id,
        first_name: member.first_name,
        last_name: member.last_name,
        email: member.email,
        phone: member.phone,
        plan_type: member.plan_type,
        status: member.status,
        signup_date: member.signup_date,
        next_billing_date: member.next_billing_date,
        monthly_rate: member.monthly_rate,
        sessions_per_day: member.sessions_per_day,
        stripe_customer_id: member.stripe_customer_id,
        stripe_subscription_id: member.stripe_subscription_id
      }
    });

  } catch (err) {
    console.error('verify-magic-link error:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify login link' });
  }
};
