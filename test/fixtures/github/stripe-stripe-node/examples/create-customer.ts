// Create a customer in TypeScript. The full type info is provided
// by the @types/stripe typings.
import Stripe from 'stripe';

const stripe = new Stripe('sk_test_xxx', { apiVersion: '2024-04-10' });

async function createCustomer(): Promise<Stripe.Customer> {
  const customer: Stripe.Customer = await stripe.customers.create({
    email: 'jenny.rosen@example.com',
    description: 'New customer from the TypeScript example',
  });
  console.log('Created customer:', customer.id);
  return customer;
}

createCustomer().catch((err: unknown) => {
  console.error('createCustomer failed:', err);
  process.exit(1);
});
