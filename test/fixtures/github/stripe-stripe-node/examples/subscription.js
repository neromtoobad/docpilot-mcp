// Create a subscription and attach a payment method.
const stripe = require('stripe')('sk_test_xxx');

async function createSubscriptionExample() {
  const subscription = await stripe.subscriptions.create({
    customer: 'cus_123',
    items: [{ price: 'price_1NqX...' }],
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  });
  console.log('Created subscription:', subscription.id);
  return subscription;
}

createSubscriptionExample().catch((err) => {
  console.error('createSubscriptionExample failed:', err);
  process.exit(1);
});
