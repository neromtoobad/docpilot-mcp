// Confirm a PaymentIntent server-side after collecting card details.
const stripe = require('stripe')('sk_test_xxx');

async function confirmPaymentIntentExample() {
  const intent = await stripe.paymentIntents.confirm(
    'pi_1NqX2C2eZvKYlo2C0FQYpZ9A',
    { payment_method: 'pm_card_visa' }
  );
  console.log('PaymentIntent status:', intent.status);
  return intent;
}

confirmPaymentIntentExample().catch((err) => {
  console.error('confirmPaymentIntentExample failed:', err);
  process.exit(1);
});
