# Changelog

## [2.32.3] - 2024-09-07

Fixed regression in 2.32.0 where `requests.Session()` constructed with `auth=` would crash on a 407 Proxy Authentication Required response.

## [2.32.2] - 2024-08-14

Security: bumped `urllib3` to 1.26.18 to pull in the proxy-authorization header fix. No API change.

## [2.32.1] - 2024-06-04

Bugfix: `Session.resolve_redirects` now copies `Authorization` headers to the redirected request when the redirect stays on the same host.

## [2.32.0] - 2024-05-20

Dropped support for Python 3.7. `requests.Session()` no longer eagerly creates the `HTTPAdapter` pool.

## [2.31.0] - 2023-05-22

Bumped `charset-normalizer` to 3.x. Removed the deprecated `requests[security]` extra.

## [2.30.0] - 2023-05-03

Bugfix: `Response.json()` now respects `Response.encoding` instead of always trusting the HTTP `Content-Type` charset.

## [2.29.0] - 2023-04-26

`Session.cookies` is now thread-safe. Added `requests.utils.parse_header_links` tests for malformed link headers.

## [2.28.2] - 2023-01-12

Backport: pin `charset-normalizer` to `<3` to avoid a regression in 2.28.x.

## [2.28.1] - 2022-06-29

PyPI-only release: regenerated wheels for Python 3.11. No code change.

## [2.28.0] - 2022-06-09

`requests.get(..., timeout=N)` now also applies to the connect step (previously it applied only to the read step).

## [2.27.1] - 2022-01-20

Bugfix: `Session()` with `proxies=` no longer crashes when the proxy URL has no port.

## [2.27.0] - 2022-01-03

Added `Session.send(prepared_request, ...)` overload that accepts a pre-built `PreparedRequest`. `requests[use_chardet_on_py3]` extra is now a no-op.
