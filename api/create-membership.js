// api/create-membership.js
// Creates a Healthspan membership:
//   1. Stripe customer + save payment method
//   2. Charge prorate (Month 1) + full Month 2 upfront
//   3. Create Stripe subscription starting Month 3 (trial until then)
//   4. Save member to Supabase
//   5. Send welcome email via Resend

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const PLAN_CONFIG = {
  regular: { price_cents: 29900, label: 'Regular Member', sessions_per_day: 3 },
  vip:     { price_cents: 49900, label: 'VIP Member',     sessions_per_day: 5 }
};

function calcProrateCents(price_cents) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remaining = daysInMonth - now.getDate() + 1; // include today
  return Math.round((remaining / daysInMonth) * price_cents);
}

function firstOfSubscriptionStart() {
  // Subscription starts first of the month after the paid-up Month 2
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 2, 1));
  return Math.floor(start.getTime() / 1000); // Unix timestamp for Stripe
}

function nextBillingDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 2, 1)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    firstName, lastName, email, phone, planType, paymentMethodId,
    paymentIntentId, // passed on 3DS retry
    utm_source, utm_medium, utm_campaign, utm_content, utm_term
  } = req.body;

  // Validate
  if (!firstName || !lastName || !email || !phone || !planType || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!PLAN_CONFIG[planType]) {
    return res.status(400).json({ error: 'Invalid plan type' });
  }

  const plan = PLAN_CONFIG[planType];
  const prorateCents = calcProrateCents(plan.price_cents);
  const totalDueCents = prorateCents + plan.price_cents;
  const subscriptionStartTs = firstOfSubscriptionStart();

  try {
    // ── 1. Check for existing member ──
    const { data: existing } = await supabase
      .from('members')
      .select('id, status')
      .eq('email', email.toLowerCase())
      .single();

    if (existing && existing.status !== 'cancelled') {
      return res.status(400).json({ error: 'An account with this email already exists. Please log into your member portal.' });
    }

    // ── 2. Create or retrieve Stripe customer ──
    let customerId;
    const existingCustomers = await stripe.customers.list({ email: email.toLowerCase(), limit: 1 });
    if (existingCustomers.data.length > 0) {
      customerId = existingCustomers.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        name: `${firstName} ${lastName}`,
        email: email.toLowerCase(),
        phone,
        metadata: { plan_type: planType, source: 'join_page' }
      });
      customerId = customer.id;
    }

    // ── 3. Attach payment method to customer ──
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // ── 4. Charge prorate + Month 2 upfront ──
    let paymentIntent;
    if (paymentIntentId) {
      // 3DS retry — confirm the existing intent
      paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId);
    } else {
      paymentIntent = await stripe.paymentIntents.create({
        amount: totalDueCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: true,
        description: `Healthspan ${plan.label} — prorate + Month 2 upfront`,
        metadata: { plan_type: planType, prorate_cents: prorateCents, month2_cents: plan.price_cents },
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
      });
    }

    // Handle 3DS
    if (paymentIntent.status === 'requires_action') {
      return res.json({
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(402).json({ error: 'Payment failed. Please check your card and try again.' });
    }

    // ── 5. Create Stripe subscription (trial until month 3 starts) ──
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price_data: {
        currency: 'usd',
        product_data: { name: `Healthspan ${plan.label}` },
        unit_amount: plan.price_cents,
        recurring: { interval: 'month' }
      }}],
      default_payment_method: paymentMethodId,
      trial_end: subscriptionStartTs,
      billing_cycle_anchor: subscriptionStartTs,
      proration_behavior: 'none',
      metadata: { plan_type: planType, member_email: email.toLowerCase() }
    });

    // ── 6. Save member to Supabase ──
    const now = new Date();
    const currentPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0); // last day of Month 2

    const { data: member, error: dbError } = await supabase
      .from('members')
      .upsert({
        first_name: firstName,
        last_name:  lastName,
        email:      email.toLowerCase(),
        phone,
        plan_type:                planType,
        status:                   'active',
        stripe_customer_id:       customerId,
        stripe_subscription_id:   subscription.id,
        stripe_payment_method_id: paymentMethodId,
        signup_date:              now.toISOString().split('T')[0],
        current_period_start:     now.toISOString().split('T')[0],
        current_period_end:       currentPeriodEnd.toISOString().split('T')[0],
        next_billing_date:        new Date(now.getFullYear(), now.getMonth() + 2, 1).toISOString().split('T')[0],
        monthly_amount_cents:     plan.price_cents,
        prorate_amount_cents:     prorateCents,
        utm_source:               utm_source || null,
        utm_medium:               utm_medium || null,
        utm_campaign:             utm_campaign || null,
        utm_content:              utm_content || null,
        utm_term:                 utm_term || null
      }, { onConflict: 'email' })
      .select()
      .single();

    if (dbError) throw dbError;

    // ── 7. Log signup activity ──
    await supabase.from('member_activity').insert({
      member_id:   member.id,
      action:      'signup',
      details:     { plan_type: planType, amount_charged_cents: totalDueCents, prorate_cents: prorateCents },
      performed_by: 'member'
    });

    // ── 8. Send welcome email with magic link ──
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await supabase.from('magic_links').insert({
      email:      email.toLowerCase(),
      token,
      expires_at: expiresAt.toISOString(),
      member_id:  member.id
    });

    const portalUrl = `${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal?token=${token}`;

    await resend.emails.send({
      from:    'Healthspan <welcome@healthspanrecovery.com>',
      to:      email,
      subject: `Welcome to Healthspan, ${firstName}! 🎉 Your portal is ready.`,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;color:#0D1B2A;">
          <div style="background:#0D1B2A;padding:24px 28px;border-radius:12px 12px 0 0;">
            <h1 style="color:white;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Healthspan</h1>
          </div>
          <div style="background:#F0FAF8;padding:28px;border-radius:0 0 12px 12px;border:1px solid #E0F2F1;">
            <h2 style="font-size:20px;font-weight:800;margin:0 0 8px;">Welcome, ${firstName}! 🎉</h2>
            <p style="color:#6B7280;margin:0 0 20px;line-height:1.6;">Your <strong>${plan.label}</strong> membership is active. Tap below to access your member portal, book your first session, and explore your benefits.</p>
            <a href="${portalUrl}" style="display:block;background:#0A7C6B;color:white;text-align:center;padding:16px 24px;border-radius:10px;text-decoration:none;font-weight:800;font-size:16px;margin-bottom:20px;">Open Your Member Portal →</a>
            <div style="background:white;border-radius:10px;padding:16px;margin-bottom:20px;">
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8EAED;font-size:14px;"><span style="color:#6B7280;">Plan</span><span style="font-weight:700;">${plan.label}</span></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8EAED;font-size:14px;"><span style="color:#6B7280;">Charged today</span><span style="font-weight:700;">$${(totalDueCents / 100).toFixed(0)}</span></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:14px;"><span style="color:#6B7280;">Next billing</span><span style="font-weight:700;">${nextBillingDate()}</span></div>
            </div>
            <p style="color:#6B7280;font-size:12px;margin:0;">This link expires in 7 days. You can always request a new one at <a href="${process.env.APP_URL || 'https://healthspan-booking.vercel.app'}/portal" style="color:#0A7C6B;">your portal page</a>.</p>
          </div>
          <p style="color:#9CA3AF;font-size:11px;text-align:center;margin-top:16px;">Healthspan Recovery · 848 Brickell Ave Suite 210, Miami FL 33131 · 786-713-1222</p>
        </div>
      `
    });

    return res.json({ success: true, memberId: member.id });

  } catch (err) {
    console.error('create-membership error:', err);
    return res.status(500).json({ error: err.message || 'An unexpected error occurred. Please try again.' });
  }
};
