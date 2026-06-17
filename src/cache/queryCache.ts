/**
 * Answer-level query cache — the third caching tier in docpilot-mcp.
 *
 * Caching hierarchy:
 *   1. Chunk cache  (src/index/store.ts)   — raw text chunks, avoids re-fetching
 *   2. Vector cache (src/index/vectorStore.ts) — hnswlib index, avoids re-embedding
 *   3. Query cache  (this file)            — full answer, avoids re-ranking
 *
 * A `QueryDocsResult` is keyed by `(ecosystem, pkg, version, hash(question))`
 * and stored as a single JSON file. Writes are atomic (tmp → rename).
 * Entries expire after `QUERY_CACHE_TTL_MS` (default 24 h) so staleness
 * is bounded even when the underlying docs site changes.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { queryCachePath, type Ecosystem } from './paths.js';
import type { QueryDocsResult } from '../tools/queryDocs.js';

/** Default TTL: 24 hours. Override with `DOCPILOT_QUERY_CACHE_TTL_MS`. */
const DEFAULT_QUERY_CACHE_TTL_MS = 86_400_000;

/** Read TTL dynamically so tests can override the env var at runtime. */
function queryTtlMs(): number {
  return Number(process.env.DOCPILOT_QUERY_CACHE_TTL_MS ?? DEFAULT_QUERY_CACHE_TTL_MS);
}

interface QueryCacheEntry {
  /** ISO timestamp of when this entry was written. */
  cachedAt: string;
  result: QueryDocsResult;
}

/** Stable 16-char hex identifier for a question string. */
export function hashQuestion(question: string): string {
  return createHash('sha256').update(question).digest('hex').slice(0, 16);
}

/**
 * Load a cached answer for an identical question, or `null` if
 * the cache is missing or has expired.
 */
export async function loadQueryCache(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  question: string,
): Promise<QueryDocsResult | null> {
  const path = queryCachePath(ecosystem, pkg, version, hashQuestion(question));
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    const entry = JSON.parse(raw) as QueryCacheEntry;
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age >= queryTtlMs()) return null;
    return entry.result;
  } catch {
    // Corrupted entry — treat as a miss.
    return null;
  }
}

/**
 * Atomically persist the answer to a question so future identical
 * queries can be served instantly from disk.
 */
export async function saveQueryCache(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  question: string,
  result: QueryDocsResult,
): Promise<void> {
  const path = queryCachePath(ecosystem, pkg, version, hashQuestion(question));
  await mkdir(dirname(path), { recursive: true });
  const entry: QueryCacheEntry = {
    cachedAt: new Date().toISOString(),
    result,
  };
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
  await rename(tmp, path);
}
