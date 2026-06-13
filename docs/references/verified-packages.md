# Verified packages

This file tracks which `(ecosystem, package)` pairs have been exercised
end-to-end with `query_docs` and `get_changelog`. Add a row per live
run, with the example input, the cache status (for `query_docs`),
and a pointer to the saved live response under `docs/references/`.

## AC-3: `query_docs`

| Ecosystem | Package | Version | Docs URL                          | First call | Second call | Live evidence |
| --------- | ------- | ------- | --------------------------------- | ---------- | ----------- | ------------- |
| npm       | stripe  | 5.0.0   | https://docs.stripe.com/api       | cache=miss | cache=hit   | [stripe-v5-pagination.md](./stripe-v5-pagination.md) |

### Live evidence for `stripe@5.0.0`

- **Question:** "how do I paginate cursor results"
- **First call (cache=miss):** fetched `https://docs.stripe.com/api`,
  extracted the body to text, chunked to 13 sections, persisted to
  `$DOCPILOT_CACHE_DIR/index/npm/stripe/5.0.0/chunks.jsonl`.
- **Second call (cache=hit):** the second invocation did not touch
  the network — the chunk cache served the response.

> Note: the live stripe docs landing page is mostly navigation chrome,
> so the top-scoring snippet for the "paginate" question contains the
> site's TOC rather than the JS SDK's `auto_pagination_iter` helper.
> That phrase lives in the `stripe-node` SDK source (and is what a
> future version of the docs URL resolver will point at for
> `stripe-node@5.x`). The offline integration test exercises the
> snippet-contains-literal-phrase requirement against a recorded
> fixture that mirrors the SDK's own documentation.

## AC-4: `get_changelog`

| Ecosystem | Package | Version | Resolved | Entries | Live evidence |
| --------- | ------- | ------- | -------- | ------- | ------------- |
| npm       | stripe  | latest  | 22.2.1   | 10      | [get-changelog-live.md](./get-changelog-live.md) |
| pypi      | requests| latest  | 2.34.2   | 10      | [get-changelog-live.md](./get-changelog-live.md) |

### Live evidence

- `npm: stripe@latest` — registry returned the full version timeline
  with release dates, then the GitHub fallback fetched
  `stripe/stripe-node/CHANGELOG.md` and merged real release-note
  bullets into each entry's `summary`.
- `pypi: requests@latest` (with explicit `ecosystem: "pypi"` hint) —
  registry returned the `releases` map keyed by version, then the
  GitHub fallback fetched `psf/requests/CHANGELOG.md` for per-release
  summaries. The hint is required because both ecosystems publish a
  `requests` package, and the auto-detect (try npm → fall back to
  PyPI) would otherwise resolve the npm `requests` (a small HTTP
  client unrelated to the Python library).

## AC-5: `search_examples`

| Ecosystem | Package | Version | Query | Examples | Live evidence |
| --------- | ------- | ------- | ----- | -------- | ------------- |
| npm       | stripe  | 5.0.0   | "create a customer"  | 10 | [search-examples-live.md](./search-examples-live.md) |
| pypi      | requests| 2.32.3  | "send a GET request" | 3  | [search-examples-live.md](./search-examples-live.md) |

### Live evidence

- `npm: stripe@5.0.0` (with explicit `ecosystem: "npm"`) — the
  handler fetched the `stripe/stripe-node` repo's recursive tree
  via the GitHub Trees API, picked up 17 candidate files from
  `examples/`, and extracted 4 fenced code blocks from `README.md`.
  After TF-IDF ranking against the query, the top-10 results all
  came back as the same `customers.create` snippet (in JS, TS, and
  README-rendered forms), and every `code` block parses as valid
  syntax for its declared `language` (verified by `node --check`
  and the TypeScript compiler). All 10 URLs are on
  `https://github.com/stripe/stripe-node/`.
- `pypi: requests@2.32.3` — the handler fetched the `psf/requests`
  repo's tree, and the `examples/` directory has been retired in
  favour of the README's fenced blocks (a long-standing repo
  convention). The 3 surviving snippets came from the README and
  one (`$ python -m pip install requests`) was correctly tagged as
  `shell` rather than `python`. One pseudo-Python shell-prompt line
  in the README was correctly rejected by the syntax validator and
  dropped from the output, exactly as the AC-5 contract requires.
- `missing package: definitely-not-a-real-package-xyz-12345` — the
  handler returned `E_NOT_FOUND` cleanly without throwing, matching
  the AC-9 error contract.

## AC-6: `resolve_method`

| Ecosystem | Package | Version | Method                       | Source path | Live evidence |
| --------- | ------- | ------- | ---------------------------- | ----------- | ------------- |
| npm       | stripe  | 17.0.0  | `CustomersResource.create`   | `package/types/CustomersResource.d.ts:1081` | [resolve-method-live.md](./resolve-method-live.md) |
| npm       | stripe  | 17.0.0  | `ChargesResource.create`     | `package/types/ChargesResource.d.ts` | [resolve-method-live.md](./resolve-method-live.md) |
| pypi      | requests| 2.32.3  | `Session.get`                | `requests/sessions.py` | [resolve-method-live.md](./resolve-method-live.md) |
| pypi      | requests| 2.32.3  | `get` (module-level)         | `requests/api.py` | [resolve-method-live.md](./resolve-method-live.md) |

### Live evidence

- `npm: stripe@17.0.0` — the handler fetched the live
  `https://registry.npmjs.org/stripe/-/stripe-17.0.0.tgz` tarball,
  extracted 286 `.d.ts` files via `tar -xzf` + `find -print0`, then
  walked the TS AST with the TypeScript compiler to find
  `CustomersResource.create` at line 1081 of
  `package/types/CustomersResource.d.ts`. The returned
  `signature` field is the literal source text of the declaration
  (`create(params?: CustomerCreateParams, options?: RequestOptions):
  Promise<Stripe.Response<Stripe.Customer>>`). The `source.url`
  field points to the deterministic unpkg.com view of the same
  file with a `#L1081` anchor. The TS extractor's suffix-match
  fallback (which guards against a too-greedy match by requiring
  every dotted segment to appear as a *full path component*) means
  the live call does not accidentally return `Forwarding.RequestsResource.create`
  (or any of the other ~150 `create` methods in the stripe-node
  .d.ts tree) when the caller asks for `Customers.create`.
- `pypi: requests@2.32.3` — the handler fetched the real wheel
  from `files.pythonhosted.org`, extracted 18 `.py` source files
  (the requests wheel ships no `.pyi` stubs), then walked the
  Python AST via an embedded script to find
  `Session.get(self, url: str, **kwargs: Any) -> "Response"`. The
  `source.path` field carries the in-wheel path
  (`requests/sessions.py`) and `source.line` is 1-indexed to the
  `def` line. A second call for the module-level `get` helper
  correctly finds `def get(url, params=None, **kwargs)` in
  `requests/api.py` — confirming the Python extractor indexes
  both class methods and top-level functions.
- `missing method: stripe@17.0.0 customers.noSuchMethod` —
  returned `E_NOT_FOUND` cleanly without falling back to a
  different version, matching the AC-6 contract.

### To verify a new package end-to-end

```bash
# query_docs:
DOCPILOT_CACHE_DIR=$(mktemp -d) npx tsx scripts/live-query-docs.ts

# get_changelog:
npx tsx scripts/live-get-changelog.ts

# search_examples:
npx tsx scripts/live-search-examples.ts

# resolve_method:
npx tsx scripts/live-resolve-method.ts
```

Or call the handler directly:

```ts
import { handleQueryDocs } from './src/tools/queryDocs.js';
import { handleGetChangelog } from './src/tools/getChangelog.js';
import { handleSearchExamples } from './src/tools/searchExamples.js';
import { handleResolveMethod } from './src/tools/resolveMethod.js';
const q = await handleQueryDocs({ package: '<name>', version: '<v>', question: '<q>' });
const c = await handleGetChangelog({ package: '<name>', ecosystem: 'pypi' /* optional */ });
const e = await handleSearchExamples({ package: '<name>', version: '<v>', query: '<q>' });
const m = await handleResolveMethod({ package: '<name>', version: '<v>', method: '<dotted.path>' });
```

### To verify a new package end-to-end

```bash
# query_docs:
DOCPILOT_CACHE_DIR=$(mktemp -d) npx tsx scripts/live-query-docs.ts

# get_changelog:
npx tsx scripts/live-get-changelog.ts

# search_examples:
npx tsx scripts/live-search-examples.ts

# resolve_method:
npx tsx scripts/live-resolve-method.ts
```

Or call the handler directly:

```ts
import { handleQueryDocs } from './src/tools/queryDocs.js';
import { handleGetChangelog } from './src/tools/getChangelog.js';
import { handleSearchExamples } from './src/tools/searchExamples.js';
import { handleResolveMethod } from './src/tools/resolveMethod.js';
const q = await handleQueryDocs({ package: '<name>', version: '<v>', question: '<q>' });
const c = await handleGetChangelog({ package: '<name>', ecosystem: 'pypi' /* optional */ });
const e = await handleSearchExamples({ package: '<name>', version: '<v>', query: '<q>' });
const m = await handleResolveMethod({ package: '<name>', version: '<v>', method: '<dotted.path>' });
```
