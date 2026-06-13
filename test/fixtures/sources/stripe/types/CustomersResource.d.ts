// Minimal fixture mimicking a portion of stripe-node's .d.ts.
// We use a nested namespace so the user's dotted path
// (e.g. "customers.create") matches the indexed AST path
// exactly. Real stripe-node uses `interface CustomersResource`
// exposed via a `Stripe.customers: CustomersResource` property;
// for v0.1 we accept that the caller knows the path either
// way and look up by exact match + last-segment suffix match.
declare namespace customers {
  function create(
    params: CustomerCreateParams,
    options?: RequestOptions,
  ): Promise<Customer>;
  function retrieve(id: string, options?: RequestOptions): Promise<Customer>;
  function list(params?: { limit?: number }, options?: RequestOptions): Promise<{ data: Customer[] }>;
  function update(
    id: string,
    params: Partial<CustomerCreateParams>,
    options?: RequestOptions,
  ): Promise<Customer>;
  function del(id: string, options?: RequestOptions): Promise<{ id: string; deleted: boolean }>;
}

export interface CustomerCreateParams {
  email?: string;
  description?: string;
  metadata?: { [key: string]: string };
}

export interface RequestOptions {
  apiVersion?: string;
  idempotencyKey?: string;
}

export interface Customer {
  id: string;
  email?: string;
  description?: string;
}
