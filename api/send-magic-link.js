// Vercel Serverless Function: /api/send-magic-link
// Generates a magic link token for passwordless login and emails it to the member.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

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

    // Verify member exists
    var { data: member, error: lookupErr } = await supabase
      .from('members')
      .select('id, first_name, email')
      .eq('email', normalizedEmail)
      .single();

    if (lookupErr || !member) {
      // Don't reveal whether email exists (security best practice)
      // Still return success to prevent email enumeration
      return res.status(200).json({
        success: true,
        message: 'If that email is registered, a login link has been sent.'
      });
    }

    // Generate secure token
    var token = crypto.randomBytes(32).toString('hex');
    var expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min expiry

    // Store token in magic_links table
    var { error: insertErr } = await supabase.from('magic_links').insert({
      email: normalizedEmail,
      token: token,
      expires_at: expiresAt,
      used: false
    });

    if (insertErr) {
      console.error('Magic link insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to create login link' });
    }

    // Build magic link URL
    var baseUrl = process.env.SITE_URL || 'https://healthspanbooking.com';
    var magicLinkUrl = baseUrl + '/portal?token=' + token;

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      var resend = new Resend(process.env.RESEND_API_KEY);

      await resend.emails.send({
        from: 'Healthspan <noreply@healthspanrecovery.com>',
        to: normalizedEmail,
        subject: 'Your Healthspan Login Link',
        html: '<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 20px;">' +
          '<h1 style="color: #0D1B2A; font-size: 24px; margin-bottom: 16px;">Sign in to Healthspan</h1>' +
          '<p style="color: #6B7280; line-height: 1.6; margin-bottom: 24px;">Hi ' + (member.first_name || 'there') + ', click the button below to access your member portal. This link expires in 15 minutes.</p>' +
          '<a href="' + magicLinkUrl + '" style="display: inline-block; background: #0A7C6B; color: white; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700;">Sign In to Portal</a>' +
          '<p style="color: #9CA3AF; font-size: 12px; margin-top: 24px; line-height: 1.5;">If you did not request this link, you can safely ignore this email. The link will expire automatically.</p>' +
          '</div>'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'If that email is registered, a login link has been sent.'
    });

  } catch (err) {
    console.error('send-magic-link error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send login link' });
  }
};
