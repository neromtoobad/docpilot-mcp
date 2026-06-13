// Create a charge against an existing customer.
const stripe = require('stripe')('sk_test_xxx');

async function createChargeExample() {
  const charge = await stripe.charges.create({
    amount: 2000,
    currency: 'usd',
    source: 'tok_visa',
    description: 'Charge for jenny.rosen@example.com',
  });
  console.log('Created charge:', charge.id);
  return charge;
}

createChargeExample().catch((err) => {
  console.error('createChargeExample failed:', err);
  process.exit(1);
});
