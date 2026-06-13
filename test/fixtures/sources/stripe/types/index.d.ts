// Top-level Stripe interface used in the stripe-node .d.ts.
import { CustomersResource } from './CustomersResource';

export interface Stripe {
  customers: CustomersResource;
  // ... many more resources
}
