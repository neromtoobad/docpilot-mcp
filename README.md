# docpilot-mcp

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes **4 tools** so any AI coding agent (Claude Code, Cursor, Codex, etc.) can fetch **live, version-accurate documentation and code examples** for any npm or PyPI package — and never again hallucinate a stale method signature.

| Tool              | What it does                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `query_docs`      | Answer a natural-language question with a cited, ranked context block from the official docs  |
| `get_changelog`   | Return the 10 most recent changelog entries for a package                                     |
| `search_examples` | Return up to 10 real code examples from the package's official `examples/` dir or `README.md` |
| `resolve_method`  | Return the current signature + parameter list for a method in a pinned version                |

The server runs locally on stdio (or over HTTP/SSE), persists a vector index in `~/.cache/docpilot-mcp/`, and never calls anything other than the package's own registry, GitHub repo, and docs site.

---

## Quick Start

```bash
# 1 — clone & install
git clone https://github.com/neromtoobad/docpilot-mcp.git
cd docpilot-mcp
npm install

# 2 — build (produces dist/)
npm run build

# 3 — wire into Claude Code (stdio)
claude mcp add docpilot -- node "$PWD/dist/index.js"

# 4 — verify the 4 tools are registered
npm run inspect
```

First call to a JS-rendered docs site (Stripe, Vercel, Cloudflare, …) triggers a one-time Playwright download:

```bash
npx playwright install chromium   # ~150 MB, only needed once
```

---

## Requirements

- **Node.js ≥ 20** (CI tests on 20 and 22)
- **npm ≥ 8** (any package manager that handles the `package.json` `exports` map)

---

## Install

```bash
git clone https://github.com/neromtoobad/docpilot-mcp.git
cd docpilot-mcp
npm install
npm run build
```

`npm install` is fully deterministic against the locked `package-lock.json`. `npm run build` runs `tsc` and exits 0.

---

## Running the server

### stdio (default — consumed by an MCP client)

```bash
npm start              # node dist/index.js
npm run dev            # tsx src/index.ts — hot reload
```

On startup the server writes one line to **stderr**:

```
info docpilot-mcp ready (tools=4)
```

It then waits for JSON-RPC messages on stdin. When the MCP client closes stdin the server exits cleanly.

### HTTP / SSE transport

```bash
npm run serve          # tsx src/server-http.ts  (dev)
npm run serve:prod     # node dist/server-http.js (production)
```

Three endpoints:

| Method | Path        | Description                              |
| ------ | ----------- | ---------------------------------------- |
| GET    | `/sse`      | Open an SSE session                      |
| POST   | `/messages` | Send JSON-RPC (`?sessionId=<id>`)        |
| GET    | `/health`   | `{ ok: true, tools: ["query_docs", …] }` |

Default port: **3000** (override with `PORT=8080 npm run serve`).

---

## Connecting a client

### Claude Code

```bash
# From npm (when published)
claude mcp add docpilot -- npx -y docpilot-mcp

# From a local build
claude mcp add docpilot -- node /abs/path/to/docpilot-mcp/dist/index.js
```

### Cursor / VS Code / any MCP client

```json
{
  "mcpServers": {
    "docpilot": {
      "command": "node",
      "args": ["/abs/path/to/docpilot-mcp/dist/index.js"]
    }
  }
}
```

---

## Tool examples

### `query_docs`

```json
{
  "package": "stripe",
  "version": "5.0.0",
  "question": "how do I paginate cursor results"
}
```

Returns a `markdown` answer (≤ 2000 tokens) plus a `sources: [{ url, section, snippet, score }]` array. The top snippet is always a literal phrase from the package's own docs.

### `get_changelog`

```json
{ "package": "stripe", "version": "latest" }
```

Returns the 10 most recent entries from npm/PyPI registry metadata, with a transparent fallback to `CHANGELOG.md` on the default branch.

### `search_examples`

```json
{
  "package": "stripe",
  "version": "5.0.0",
  "query": "create a customer"
}
```

Returns up to 10 `{ code, path, url, language }` blocks. Every `url` points to the official GitHub repo.

### `resolve_method`

```json
{
  "package": "stripe",
  "version": "5.0.0",
  "method": "customers.create"
}
```

Returns `{ signature, params, returns, source: { url, path, line } }`. For npm packages the signature is parsed from the `.d.ts` inside the tarball; for PyPI from `.pyi` stubs or Python AST.

---

## Environment variables

| Variable                   | Default                  | Description                                        |
| -------------------------- | ------------------------ | -------------------------------------------------- |
| `DOCPILOT_CACHE_DIR`       | `~/.cache/docpilot-mcp`  | Root for chunk cache, vector indexes, raw HTML     |
| `DOCPILOT_EMBED_CACHE_DIR` | `~/.cache/docpilot-mcp/models` | Where Xenova model weights are stored         |
| `DOCPILOT_USER_AGENT`      | `docpilot-mcp/0.1.0`    | User-Agent header sent to registries and docs sites|
| `LOG_LEVEL`                | `info`                   | `debug` \| `info` \| `warn` \| `error`            |
| `PORT`                     | `3000`                   | HTTP/SSE transport listen port                     |

---

## Caching

- Default cache root: `~/.cache/docpilot-mcp/`
- Layout: `index/<ecosystem>/<package>/<version>/` for the vector store, plus a `raw/` tree for cached HTML and tarballs
- All disk writes are atomic (`*.tmp` → rename)
- Vector index: hnswlib-node, 384-dim (all-MiniLM-L6-v2); auto-rebuilds on model change

---

## Cloud deployment (Railway / Render / Fly)

For remote HTTP/SSE access, deploy the HTTP server:

```bash
# Dockerfile-free: Railway / Render can use this command
npm run build && PORT=$PORT node dist/server-http.js
```

Or via `npx` without cloning:

```bash
# once published to npm
npx docpilot-mcp          # starts stdio server
PORT=3000 npx docpilot-mcp-http   # starts HTTP/SSE server (planned)
```

Health check endpoint: `GET /health` returns HTTP 200 with `{ ok: true }` — plug this into Railway's health-check URL.

---

## Testing

```bash
npm test            # vitest run (90 tests, fully offline)
npm run test:watch  # watch mode
```

All tests use recorded fixtures under `test/fixtures/` — no network access required.

---

## Project layout

```
src/
  index.ts              # entry point — wires stdio transport
  server.ts             # MCP Server factory + tool registration
  server-http.ts        # HTTP/SSE transport (GET /sse, POST /messages)
  tools/                # the 4 tool handlers (one file per tool)
  sources/              # fetchPage, registry clients, GitHub resolver
  extractors/           # TS / Python / markdown chunkers
  index/                # embeddings + hnswlib store + TF-IDF fallback
  net/                  # rate-limited, retrying HTTP client
  cache/                # content-addressed paths
  util/                 # logger, error helpers
test/                   # vitest specs + offline fixtures
.github/workflows/      # CI — Node 20 & 22, build + test on every push
```

---

## License

MIT
