// Vercel Serverless Function — Stripe Payment Intent
// Secret key stored safely in Vercel environment variables (never in code)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { amount, chamber, email } = req.body;

  if (!amount || !chamber || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        amount: String(Math.round(amount * 100)),
        currency: 'usd',
        receipt_email: email,
        'metadata[chamber]': chamber,
        'metadata[source]': 'healthspan-booking',
        'automatic_payment_methods[enabled]': 'true'
      })
    });

    const paymentIntent = await response.json();

    if (!response.ok) {
      throw new Error(paymentIntent.error?.message || 'Stripe error');
    }

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
