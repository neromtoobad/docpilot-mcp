// Create a Stripe customer with an email and description.
const stripe = require('stripe')('sk_test_xxx');

async function createCustomerExample() {
  const customer = await stripe.customers.create({
    email: 'jenny.rosen@example.com',
    description: 'New customer created from the create-customer example',
  });
  console.log('Created customer:', customer.id);
  return customer;
}

createCustomerExample().catch((err) => {
  console.error('createCustomerExample failed:', err);
  process.exit(1);
});
