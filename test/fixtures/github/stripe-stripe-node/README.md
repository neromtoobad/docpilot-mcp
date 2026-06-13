# stripe-node examples

Sample code for the Stripe Node SDK.

## Quickstart

```javascript
const stripe = require('stripe')('sk_test_xxx');
const customer = await stripe.customers.create({
  email: 'jenny.rosen@example.com',
});
console.log(customer.id);
```

## Charging a card

```javascript
const charge = await stripe.charges.create({
  amount: 2000,
  currency: 'usd',
  source: 'tok_visa',
});
```

## TypeScript snippet

```typescript
import Stripe from 'stripe';
const stripe = new Stripe('sk_test_xxx');
const intent = await stripe.paymentIntents.create({
  amount: 2000,
  currency: 'usd',
});
```

## Webhook signature verification (Node)

```javascript
const event = stripe.webhooks.constructEvent(
  payload,
  signatureHeader,
  webhookSecret,
);
```
