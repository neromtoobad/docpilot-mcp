# Changelog

All notable changes to this project will be documented in this file.

## 5.9.0 — 2024-09-03

Added support for the v2 tax API. New `Tax.Registration` resource. Deprecated `Tax.Transaction` in favor of `tax.calculations` and `tax.transactions`.

## 5.8.0 — 2024-08-20

Added `PaymentIntent.payment_method_options.klarna` and bumped the Klarna API to v2. Several bugfixes around refund reason codes.

## 5.7.0 — 2024-08-06

New `customer_session` resource. Added support for `payment_method_options.card.installments` on SetupIntents.

## 5.6.0 — 2024-07-23

Added `expand` shorthand for nested fields. Auto-pagination iterators now correctly yield `deleted` resources when the list filter includes them.

## 5.5.0 — 2024-07-09

`stripe.rawRequest` now returns the response body buffer alongside the parsed object. Bugfix: `auto_pagination_iter` no longer double-paginates when the page size is exactly `limit`.

## 5.4.0 — 2024-06-25

Added `StripeResource` base class for custom resources. Bumped `apiVersion` to `2024-06-20`.

## 5.3.0 — 2024-06-11

Initial support for the Treasury platform. New `financial_account` resource behind the `treasury` feature flag.

## 5.2.1 — 2024-05-28

Patch: `RequestSpy` no longer throws on missing `idempotency-key` headers in mock mode. CI matrix bumped to Node 18, 20, 22.

## 5.2.0 — 2024-05-21

`Stripe.createFetchHttpClient` exposes the underlying `fetch` so apps can add global request hooks (auth, tracing).

## 5.1.0 — 2024-05-07

TypeScript: exported the previously-internal `RequestOptions` type. Python: equivalent `RequestOptions` was already exported.

## 5.0.1 — 2024-04-23

Backport: `auto_pagination_iter` early-termination on empty pages (was: hot-patched in 5.0.0).

## 5.0.0 — 2024-04-09

Dropped Node 14 and 16. Required `apiVersion` is now `2024-04-03`. New `auto_pagination_iter` helper exposes the underlying cursor as an async iterator. `rawRequest` is now the recommended way to issue non-standard requests.
