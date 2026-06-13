// Verifying webhook signatures from Stripe.
// This example uses Express and the raw-body middleware.
const stripe = require('stripe')('sk_test_xxx');
const express = require('express');
const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), (request, response) => {
  const sig = request.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, sig, 'whsec_xxx');
  } catch (err) {
    response.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('PaymentIntent was successful!', paymentIntent.id);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  response.json({ received: true });
});

app.listen(4242, () => console.log('Running on port 4242'));
