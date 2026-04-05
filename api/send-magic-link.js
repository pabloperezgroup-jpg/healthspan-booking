// api/send-magic-link.js
// Sends a magic link email to an existing member for portal access.
// Always returns success (never reveals if email exists or not).

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Always return success — never reveal if email exists
  res.json({ success: true });

  try {
    const { data: member } = await supabase
      .from('members')
      .select('id, first_name, status')
      .eq('email', email.toLowerCase())
      .not('status', 'eq', 'cancelled')
      .single();

    if (!member) return; // silently do nothing

    // Generate token — 15 minute expiry
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await supabase.from('magic_links').insert({
      email:      email.toLowerCase(),
      token,
      expires_at: expiresAt.toISOString(),
      member_id:  member.id
    });

    const portalUrl = `${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal?token=${token}`;

    await resend.emails.send({
      from:    'Healthspan <noreply@healthspanrecovery.com>',
      to:      email,
      subject: 'Your Healthspan portal link',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:480px;margin:0 auto;color:#0D1B2A;">
          <div style="background:#0D1B2A;padding:20px 24px;border-radius:12px 12px 0 0;">
            <h1 style="color:white;margin:0;font-size:20px;font-weight:800;">Healthspan</h1>
          </div>
          <div style="background:white;padding:28px;border-radius:0 0 12px 12px;border:1px solid #E8EAED;">
            <p style="font-size:18px;font-weight:800;margin:0 0 8px;">Hi ${member.first_name} 👋</p>
            <p style="color:#6B7280;margin:0 0 24px;line-height:1.6;">Tap the button below to open your member portal. This link works once and expires in 15 minutes.</p>
            <a href="${portalUrl}" style="display:block;background:#0A7C6B;color:white;text-align:center;padding:16px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;margin-bottom:20px;">Open My Portal →</a>
            <p style="color:#9CA3AF;font-size:12px;margin:0;">Didn't request this? Ignore this email — your account is safe.</p>
          </div>
          <p style="color:#9CA3AF;font-size:11px;text-align:center;margin-top:14px;">Healthspan Recovery · 848 Brickell Ave Suite 210, Miami FL 33131</p>
        </div>
      `
    });
  } catch (err) {
    console.error('send-magic-link error:', err);
    // Don't expose errors to client
  }
};
