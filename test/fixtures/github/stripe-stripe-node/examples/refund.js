// Refund a charge by id.
const stripe = require('stripe')('sk_test_xxx');

async function refundChargeExample() {
  const refund = await stripe.refunds.create({
    charge: 'ch_1NqX2C2eZvKYlo2C0FQYpZ9A',
  });
  console.log('Refunded:', refund.id);
  return refund;
}

refundChargeExample().catch((err) => {
  console.error('refundChargeExample failed:', err);
  process.exit(1);
});
