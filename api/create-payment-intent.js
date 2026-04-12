// Vercel Serverless Function: /api/create-payment-intent
// Creates a Stripe PaymentIntent for the booking page (HBOT sessions).
// Used by index.html when a customer books their first session.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var { amount, chamber, email } = req.body;

    // ── Validate ──
    if (!amount || !chamber) {
      return res.status(400).json({ error: 'Missing required fields: amount, chamber' });
    }

    // Validate chamber type and amount match
    var validAmounts = { soft: 49, hard: 99 };
    if (!validAmounts[chamber]) {
      return res.status(400).json({ error: 'Invalid chamber type' });
    }
    // Use server-side price (don't trust client amount)
    var amountCents = validAmounts[chamber] * 100;

    // Clean email
    var customerEmail = (email || 'guest@healthspan.com').toLowerCase().trim();

    // ── Create PaymentIntent ──
    var paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      // No receipt_email — we send a single combined confirmation via Resend instead
      metadata: {
        type: 'hbot_booking',
        chamber: chamber,
        original_price: chamber === 'soft' ? '149' : '199',
        discount: '100',
        customer_email: customerEmail
      },
      payment_method_types: ['card']
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret
    });

  } catch (err) {
    console.error('create-payment-intent error:', err);
    return res.status(500).json({
      error: err.message || 'Failed to create payment. Please try again.'
    });
  }
};
