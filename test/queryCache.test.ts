/**
 * Answer-level query cache — unit tests for src/cache/queryCache.ts.
 *
 * Verifies the three-tier caching contract: identical questions are
 * served from disk (tier 3) without re-ranking or re-fetching.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hashQuestion,
  loadQueryCache,
  saveQueryCache,
} from '../src/cache/queryCache.js';
import type { QueryDocsResult } from '../src/tools/queryDocs.js';

const SAMPLE_RESULT: QueryDocsResult = {
  package: 'stripe',
  version: '5.0.0',
  answer_markdown:
    '## Paginating cursor results\n\nUse `starting_after` to paginate.',
  sources: [
    {
      url: 'https://docs.stripe.com/api',
      section: 'Pagination',
      snippet: 'Use starting_after to paginate.',
      score: 0.9,
    },
  ],
};

let tempCacheRoot: string;

beforeEach(() => {
  tempCacheRoot = mkdtempSync(join(tmpdir(), 'docpilot-querycache-test-'));
  process.env.DOCPILOT_CACHE_DIR = tempCacheRoot;
});

afterEach(() => {
  try { rmSync(tempCacheRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.DOCPILOT_CACHE_DIR;
  delete process.env.DOCPILOT_QUERY_CACHE_TTL_MS;
});

describe('hashQuestion', () => {
  it('returns a 16-char hex string', () => {
    const h = hashQuestion('how do I paginate cursor results');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    const q = 'how do I paginate cursor results';
    expect(hashQuestion(q)).toBe(hashQuestion(q));
  });

  it('produces different hashes for different questions', () => {
    expect(hashQuestion('question A')).not.toBe(hashQuestion('question B'));
  });
});

describe('loadQueryCache / saveQueryCache round-trip', () => {
  it('returns null for a missing entry', async () => {
    const result = await loadQueryCache('npm', 'stripe', '5.0.0', 'anything');
    expect(result).toBeNull();
  });

  it('round-trips a result through save → load', async () => {
    await saveQueryCache('npm', 'stripe', '5.0.0', 'how do I paginate', SAMPLE_RESULT);
    const loaded = await loadQueryCache('npm', 'stripe', '5.0.0', 'how do I paginate');
    expect(loaded).toEqual(SAMPLE_RESULT);
  });

  it('is keyed by exact question text (different questions → different entries)', async () => {
    await saveQueryCache('npm', 'stripe', '5.0.0', 'question A', SAMPLE_RESULT);
    const loaded = await loadQueryCache('npm', 'stripe', '5.0.0', 'question B');
    expect(loaded).toBeNull();
  });

  it('is keyed by package version', async () => {
    await saveQueryCache('npm', 'stripe', '4.0.0', 'paginate', SAMPLE_RESULT);
    const loaded = await loadQueryCache('npm', 'stripe', '5.0.0', 'paginate');
    expect(loaded).toBeNull();
  });

  it('respects DOCPILOT_QUERY_CACHE_TTL_MS=0 to force expiry', async () => {
    await saveQueryCache('npm', 'stripe', '5.0.0', 'paginate', SAMPLE_RESULT);
    process.env.DOCPILOT_QUERY_CACHE_TTL_MS = '0';
    const loaded = await loadQueryCache('npm', 'stripe', '5.0.0', 'paginate');
    expect(loaded).toBeNull();
  });
});
