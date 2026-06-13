# docpilot-mcp

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes **4 tools** so any AI coding agent (Claude Code, Cursor, Codex, etc.) can fetch **live, version-accurate documentation and code examples** for any npm or PyPI package — and never again hallucinate a stale method signature.

| Tool             | What it does                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `query_docs`     | Answer a natural-language question with a cited, ranked context block from the official docs |
| `get_changelog`  | Return the 10 most recent changelog entries for a package                                    |
| `search_examples`| Return up to 10 real code examples from the package's official `examples/` dir or `README.md` |
| `resolve_method` | Return the current signature + parameter list for a method in a pinned version                |

The server runs locally on stdio, persists a vector index in `~/.cache/docpilot-mcp/`, and never calls anything other than the package's own registry, GitHub repo, and docs site.

---

## Requirements

- **Node.js ≥ 20** (this project is tested on Node 24)
- **npm ≥ 11** (any package manager that understands the `package.json` `exports` map)
- For JS-rendered doc sites (Stripe, Vercel, Cloudflare, etc.) the first call will need a one-time **`npx playwright install chromium`** download (~150 MB)

## Install

```bash
git clone <this repo> docpilot-mcp
cd docpilot-mcp
npm install
npm run build
```

`npm install` is fully deterministic against the locked `package-lock.json`. `npm run build` produces `dist/` and exits 0.

## Run

```bash
# Foreground stdio server (consumed by an MCP client)
npm start

# Dev mode with tsx hot reload
npm run dev

# Enumerate the 4 tools + their descriptions
npm run inspect
```

On startup the server writes a single line to **stderr**:

```
info docpilot-mcp ready (tools=4)
```

It then waits for JSON-RPC messages on stdin. When the parent MCP client closes stdin the server exits with code 0.

## Pointing a client at the server

Once the package is published:

```bash
# Claude Code
claude mcp add docpilot -- npx -y docpilot-mcp

# Cursor / Codex (config file)
#   command:    npx
#   args:       -y
#   other args: docpilot-mcp
```

From a local checkout before publishing:

```bash
# Claude Code
claude mcp add docpilot -- node /abs/path/to/docpilot-mcp/dist/index.js
```

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

Returns the 10 most recent entries from the npm registry metadata, with a transparent fallback to `CHANGELOG.md` on the default branch.

### `search_examples`

```json
{
  "package": "stripe",
  "version": "5.0.0",
  "query": "create a customer"
}
```

Returns up to 10 `{ code, path, url, language }` blocks. Every `url` is on `github.com` under the package's official repo.

### `resolve_method`

```json
{
  "package": "stripe",
  "version": "5.0.0",
  "method": "customers.create"
}
```

Returns `{ signature, params, returns, source: { url, path, line } }`. The signature is parsed from the `.d.ts` file inside the npm tarball; the `line` is 1-indexed.

## Caching

- Default cache root: `~/.cache/docpilot-mcp/`
- Layout: `index/<ecosystem>/<package>/<version>/` for the vector store, plus a `raw/` tree for cached HTML and tarballs
- All disk writes are atomic (`*.tmp` → rename)
- See [`docs/cache-format.md`](docs/cache-format.md) (added in AC-7) for the full schema

## Testing

```bash
npm test            # runs vitest run
npm run test:watch  # watch mode
```

The test suite uses recorded fixtures under `test/fixtures/` so it stays fully offline and deterministic.

## Project layout

```
src/
  index.ts              # entry point — wires transport + handlers
  server.ts             # MCP Server factory + tool registration table
  tools/                # the 4 tool handlers (one file per tool)
  sources/              # fetchPage, registry clients, GitHub resolver
  extractors/           # TS / Python / markdown chunkers
  index/                # embeddings + hnswlib store
  browser/              # playwright singleton pool
  net/                  # rate-limited, retrying HTTP client
  cache/                # content-addressed paths
  util/                 # logger, error helpers
test/                   # vitest specs + fixtures
docs/
  references/           # recorded raw materials (browser snapshots, registry JSON)
  cache-format.md
  verified-packages.md
```

## License

MIT
