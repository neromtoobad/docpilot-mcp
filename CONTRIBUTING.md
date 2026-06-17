# Contributing to docpilot-mcp

Thank you for your interest in contributing! This document covers the development workflow, code conventions, and testing requirements.

## Prerequisites

- **Node.js ≥ 20** (CI tests 20 and 22)
- **npm ≥ 8**
- Optional: `npx playwright install chromium` for JS-rendered docs site tests (~150 MB)

## Setup

```bash
git clone https://github.com/neromtoobad/docpilot-mcp.git
cd docpilot-mcp
npm install
npm run build   # tsc — must exit 0
npm test        # vitest run — must be 100% green
```

## Project layout

```
src/
  tools/          # one file per MCP tool (query_docs, get_changelog, …)
  sources/        # page fetchers, registry clients, GitHub resolver
  extractors/     # TS AST, Python AST, markdown chunkers
  index/          # vector store (hnswlib-node), TF-IDF fallback, embedder
  cache/          # content-addressed path helpers, query result cache
  net/            # rate-limited, retrying HTTP client with SSRF guard
  util/           # logger, error helpers
test/             # vitest specs — must stay fully offline
```

## Development workflow

```bash
npm run dev         # tsx hot-reload stdio server
npm run serve       # tsx HTTP/SSE server on :3000
npm run inspect     # print registered tools and exit
npm run test:watch  # vitest in watch mode
```

## Adding a new known docs site

Edit `src/sources/docsSite.ts` and add an entry to `KNOWN_DOCS`:

```typescript
'npm:my-package': { url: 'https://docs.my-package.com/', ecosystem: 'npm' },
```

The key format is `<ecosystem>:<package-name-lowercase>`.

## Adding or modifying a tool

Each tool lives in `src/tools/<toolName>.ts` and exports two things:

1. `handle<ToolName>(args, deps)` — the pure handler, injectable deps for testing
2. `register<ToolName>(server)` — registers the tool on an `McpServer`

All IO is injected via the `deps` object so tests can run fully offline without mocking network calls at the module level.

## Testing requirements

- **All tests must run offline.** Use fixtures in `test/fixtures/` for HTTP responses.
- **No real network calls in tests.** Mock `http`, `fetchPage`, and registry clients via deps injection.
- **Atomic writes** — all cache writes must use the `tmp → rename` pattern (see `src/index/store.ts`).
- The CI matrix runs Node 20 and 22. Test on both if you change native bindings.

```bash
npm test        # must exit 0 with no skipped tests
npm run build   # must exit 0 with no type errors
```

## Code conventions

- **TypeScript strict mode** (`"strict": true` in tsconfig.json). No `any`.
- **ESM only** — `"type": "module"`, `NodeNext` module resolution. Always use `.js` extensions on imports.
- **No barrel files** — import directly from the source module.
- **Error handling** — return `{ ok: false, code: ToolErrorCode, message }` from handlers; never throw past a tool boundary.
- **Logging** — use `src/util/log.ts` (`debug`, `info`, `warn`, `error`). MCP stdio servers must not write to stdout.
- **Security** — never fetch URLs outside the `FetchHttpClient` (which includes the SSRF guard). Validate all user-supplied inputs at the tool boundary.

## Pull request checklist

- [ ] `npm run build` exits 0
- [ ] `npm test` exits 0 (all tests green, no skipped)
- [ ] New behaviour is covered by at least one test using offline fixtures
- [ ] No plaintext secrets committed
- [ ] CHANGELOG.md updated under `[Unreleased]` if this is a user-visible change

## Reporting bugs

Open an issue on GitHub with:
- Node.js version (`node --version`)
- Package name and version that triggered the problem
- The full stderr output (set `LOG_LEVEL=debug` for verbose output)
