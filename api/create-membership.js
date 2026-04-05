// Vercel Serverless Function: /api/create-membership
// Creates a new Healthspan member: charges upfront (prorated + month 2),
// creates Stripe subscription starting on the 1st of month-after-next,
// inserts member into Supabase, sends welcome email via Resend.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// ── Plan config ──
const PLANS = {
  regular: { label: 'Regular Member', price_cents: 29900, sessions_per_day: 3 },
  vip:     { label: 'VIP Member',     price_cents: 49900, sessions_per_day: 5 }
};

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      firstName, lastName, email, phone,
      planType, paymentMethodId,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term
    } = req.body;

    // ── Validate inputs ──
    if (!firstName || !lastName || !email || !phone || !planType || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const plan = PLANS[planType];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan type. Must be "regular" or "vip".' });
    }

    // ── Calculate proration ──
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const today = now.getDate();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const remainingDays = daysInMonth - today + 1; // include today
    const proratedCents = Math.round((remainingDays / daysInMonth) * plan.price_cents);
    const upfrontCents = proratedCents + plan.price_cents; // prorated month 1 + full month 2

    // ── Subscription start: 1st of month after next ──
    var subStartMonth = month + 2;
    var subStartYear = year;
    if (subStartMonth > 11) {
      subStartMonth -= 12;
      subStartYear += 1;
    }
    const subscriptionStartDate = new Date(Date.UTC(subStartYear, subStartMonth, 1, 0, 0, 0));
    const subscriptionStartTs = Math.floor(subscriptionStartDate.getTime() / 1000);

    // ── 1. Create or retrieve Stripe customer ──
    const normalizedEmail = email.toLowerCase().trim();
    var customer;
    const existing = await stripe.customers.list({ email: normalizedEmail, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
      await stripe.customers.update(customer.id, {
        name: firstName + ' ' + lastName,
        phone: phone,
        metadata: { plan_type: planType }
      });
    } else {
      customer = await stripe.customers.create({
        email: normalizedEmail,
        name: firstName + ' ' + lastName,
        phone: phone,
        metadata: { plan_type: planType }
      });
    }
    const customerId = customer.id;

    // ── 2. Attach payment method ──
    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (attachErr) {
      // If already attached to this customer, that's fine
      if (!attachErr.message || !attachErr.message.includes('already been attached')) {
        throw attachErr;
      }
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });

    // ── 3. Charge upfront amount (prorated month 1 + full month 2) ──
    const paymentIntent = await stripe.paymentIntents.create({
      amount: upfrontCents,
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
payment_method_types: ['card'],
confirm: true,
      off_session: false,
      metadata: {
        type: 'membership_signup',
        plan_type: planType,
        prorated_cents: String(proratedCents),
        month2_cents: String(plan.price_cents),
        member_email: normalizedEmail
      }
    });

    // Handle 3D Secure / requires_action
    if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
      return res.status(200).json({
        success: false,
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    }

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment failed with status: ' + paymentIntent.status });
    }

    // ── 4. Find or create Stripe product for this plan ──
    const productName = 'Healthspan ' + plan.label;
    var product;
    const existingProducts = await stripe.products.list({ limit: 100 });
    product = existingProducts.data.find(function(p) { return p.name === productName && p.active; });
    if (!product) {
      product = await stripe.products.create({
        name: productName,
        metadata: { plan_type: planType }
      });
    }

    // ── 5. Create Stripe subscription ──
    // FIX: Use trial_end ONLY — no billing_cycle_anchor, no proration_behavior.
    // When a trial ends on the 1st, Stripe naturally anchors all future billing to the 1st.
    // This avoids the "anchored invoice must be prorated" error entirely.
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{
        price_data: {
          currency: 'usd',
          product: product.id,
          unit_amount: plan.price_cents,
          recurring: { interval: 'month' }
        }
      }],
      default_payment_method: paymentMethodId,
      trial_end: subscriptionStartTs,
      metadata: {
        plan_type: planType,
        member_email: normalizedEmail
      }
    });

    // ── 6. Insert member into Supabase ──
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const memberData = {
      first_name: firstName,
      last_name: lastName,
      email: normalizedEmail,
      phone: phone,
      plan_type: planType,
      status: 'active',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_payment_method_id: paymentMethodId,
      signup_date: now.toISOString(),
      current_period_start: now.toISOString(),
      current_period_end: subscriptionStartDate.toISOString(),
      next_billing_date: subscriptionStartDate.toISOString().split('T')[0],
      monthly_rate: plan.price_cents,
      prorated_amount: proratedCents,
      upfront_paid: upfrontCents,
      sessions_per_day: plan.sessions_per_day,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_content: utm_content || null,
      utm_term: utm_term || null
    };

    const { data: member, error: dbError } = await supabase
      .from('members')
      .upsert(memberData, { onConflict: 'email' })
      .select()
      .single();

    if (dbError) {
      console.error('Supabase insert error:', dbError);
      // Don't fail the request — Stripe is already charged. Log and continue.
    }

    // ── 7. Log signup activity ──
    try {
      await supabase.from('member_activity').insert({
        member_id: member ? member.id : null,
        email: normalizedEmail,
        action: 'signup',
        details: JSON.stringify({
          plan_type: planType,
          upfront_paid: upfrontCents,
          prorated: proratedCents,
          subscription_starts: subscriptionStartDate.toISOString().split('T')[0]
        })
      });
    } catch (logErr) {
      console.error('Activity log error:', logErr);
    }

    // ── 8. Send welcome email via Resend ──
    if (process.env.RESEND_API_KEY) {
      try {
        var resend = new Resend(process.env.RESEND_API_KEY);
        var nextBilling = subscriptionStartDate.toLocaleDateString('en-US', {
          month: 'long', day: 'numeric', year: 'numeric'
        });

        await resend.emails.send({
          from: 'Healthspan <noreply@healthspanrecovery.com>',
          to: normalizedEmail,
          subject: 'Welcome to Healthspan!',
          html: '<div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 20px;">' +
            '<h1 style="color: #0D1B2A; font-size: 24px;">Welcome to Healthspan!</h1>' +
            '<p style="color: #6B7280; line-height: 1.6;">Hi ' + firstName + ', your <strong>' + plan.label + '</strong> membership is now active.</p>' +
            '<div style="background: #F0FAF8; border-radius: 12px; padding: 20px; margin: 20px 0;">' +
            '<p style="margin: 0 0 8px; font-size: 14px; color: #6B7280;">Charged today</p>' +
            '<p style="margin: 0 0 16px; font-size: 22px; font-weight: 800; color: #0A7C6B;">$' + (upfrontCents / 100).toFixed(2) + '</p>' +
            '<p style="margin: 0 0 4px; font-size: 14px; color: #6B7280;">Next billing date</p>' +
            '<p style="margin: 0; font-size: 16px; font-weight: 700; color: #0D1B2A;">' + nextBilling + '</p>' +
            '</div>' +
            '<p style="color: #6B7280; font-size: 14px; line-height: 1.6;">You can now book sessions and manage your membership through your member portal.</p>' +
            '<a href="https://healthspanbooking.com/portal" style="display: inline-block; background: #0A7C6B; color: white; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; margin-top: 16px;">Go to Member Portal</a>' +
            '</div>'
        });
      } catch (emailErr) {
        console.error('Email send error:', emailErr);
      }
    }

    // ── 9. Success response ──
    return res.status(200).json({
      success: true,
      memberId: member ? member.id : null,
      customerId: customerId,
      subscriptionId: subscription.id,
      planType: planType,
      upfrontCharged: upfrontCents,
      nextBillingDate: subscriptionStartDate.toISOString().split('T')[0]
    });

  } catch (err) {
    console.error('create-membership error:', err);
    return res.status(500).json({
      error: err.message || 'An unexpected error occurred. Please try again.'
    });
  }
};
