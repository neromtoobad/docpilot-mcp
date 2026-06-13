// List the first 3 customers on the account.
const stripe = require('stripe')('sk_test_xxx');

async function listCustomersExample() {
  const customers = await stripe.customers.list({ limit: 3 });
  for (const customer of customers.data) {
    console.log(customer.id, customer.email);
  }
  return customers;
}

listCustomersExample().catch((err) => {
  console.error('listCustomersExample failed:', err);
  process.exit(1);
});
