# docpilot-mcp — project standards

This file defines the working standards any Claude (or compatible coding agent) MUST follow when contributing to this repository. It is intentionally short; the implementation plan lives in `.humanize/rlcr/<id>/plan.md` and the goal tracker in `.humanize/rlcr/<id>/goal-tracker.md`.

## Mission

Build a TypeScript MCP server that exposes exactly 4 tools (`query_docs`, `get_changelog`, `search_examples`, `resolve_method`) so AI coding agents can fetch live, version-accurate documentation and code examples for any npm or PyPI package.

## Stack

- **Language:** TypeScript 5.6+, `strict: true`, ESM (`"type": "module"`), `NodeNext` resolution, `target: ES2022`
- **Runtime:** Node 20+
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.x (uses `McpServer.registerTool` API)
- **HTTP:** plain `fetch` + a thin wrapper in `src/net/httpClient.ts` (10 req/s per host, 3 retries, 15 s timeout)
- **HTML:** `cheerio` for static, `playwright` (singleton chromium) for JS-rendered
- **Embeddings:** `@xenova/transformers` (`all-MiniLM-L6-v2`, 384-dim, fully local)
- **Vector index:** `hnswlib-node` (in-process, persisted to `~/.cache/docpilot-mcp/`)
- **Validation:** `zod` schemas co-located with each tool handler
- **Tests:** `vitest` + recorded fixtures under `test/fixtures/`

## Repository conventions

- **Layout follows the plan exactly.** New files go under the directory assigned in `.humanize/.../plan.md`. Do not invent new top-level folders.
- **One tool per file.** Each of the 4 tools lives at `src/tools/<name>.ts` exporting a `register<Name>(server: McpServer): void` function.
- **Errors are typed.** Use `toolError(code, message, details?)` from `src/util/errors.js`. The `code` is one of `E_NOT_FOUND | E_RATE_LIMIT | E_UPSTREAM | E_INVALID_INPUT | E_INTERNAL | E_NOT_IMPLEMENTED`.
- **Logs go to stderr.** Use `log`/`info`/`warn`/`error` from `src/util/log.js`. Never `console.log`.
- **No `any`.** Strict TypeScript is on. If a library forces `any`, isolate it behind a typed wrapper and a TODO referencing the library name.
- **Atomic disk writes.** Write to `*.tmp` then `fs.rename` to the final path.

## Working loop

1. Read the plan + the goal tracker before starting any work.
2. Pick exactly **one** acceptance criterion (AC) per round and stop when it's verifiable.
3. Validate with the **narrowest** test that proves the AC is met — never a full slow suite.
4. Update the goal tracker (Active Tasks table, Plan Evolution Log) before committing.
5. Commit in the form `chore(AC-N): <verb> <noun>`. No "WIP" or "fix typo" commits.

## Sources of truth — and what is NOT one

- **In scope as source of truth:** the package's own docs site, its GitHub repo (README, examples/, CHANGELOG.md, .d.ts / .pyi), and the npm or PyPI registry metadata.
- **Out of scope (never fetch):** Stack Overflow, dev.to, MDN mirrors, npmjs.com README pages, third-party aggregator blogs. The server is a fetcher + ranker, not a writer.

## Verifying live docs

- For any live verification of a JS-rendered site, use the preinstalled **`agent-browser`** CLI via the `agent-browser` skill. Save raw materials (HTML, screenshots) under `docs/references/`.

## Don'ts

- Don't add hosted/SaaS surfaces, auth, telemetry, or a web UI.
- Don't bring in ecosystem clients for Cargo / Go / RubyGems / Maven in v0.1.0.
- Don't silently drift from the plan — if the implementation route needs to change, write the rationale into the Plan Evolution Log.
