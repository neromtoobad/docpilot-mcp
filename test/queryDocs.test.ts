/**
 * AC-3 — `query_docs` returns a version-accurate, cited, ranked
 * context block. The plan's verification matrix says:
 *
 *   "Test asserts answer_markdown contains a phrase from
 *    docs/references/stripe-v5-pagination.md; second call within 1s
 *    logs cache=hit."
 *
 * We exercise the documented output contract against a recorded
 * fixture (the `test/fixtures/stripe-pagination-docs.json` HTML is
 * the same content as `docs/references/stripe-v5-pagination.md`).
 * Each test gets a fresh temp cache root so the real
 * ~/.cache/docpilot-mcp is never touched and tests do not leak
 * state.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleQueryDocs, type QueryDocsArgs } from '../src/tools/queryDocs.js';
import type { Chunk } from '../src/extractors/markdownChunks.js';
import type { FetchedPage } from '../src/sources/fetchPage.js';
import { chunkText } from '../src/extractors/markdownChunks.js';
import { loadChunks, saveChunks, hasChunks } from '../src/index/store.js';
import { rankChunks } from '../src/index/lexical.js';

import stripeFixture from './fixtures/stripe-pagination-docs.json' with { type: 'json' };

const STRIPE_VERSION = '5.0.0';

const stripeFixturePage: FetchedPage = {
  url: stripeFixture.url,
  title: stripeFixture.title,
  html: stripeFixture.html,
  text: htmlToPlainText(stripeFixture.html),
};

function htmlToPlainText(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n- $1\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '$1')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const baseArgs: QueryDocsArgs = {
  package: 'stripe',
  version: STRIPE_VERSION,
  question: 'how do I paginate cursor results',
};

let tempCacheRoot: string;

beforeEach(() => {
  // Fresh temp cache root per test → no state leaks.
  tempCacheRoot = mkdtempSync(join(tmpdir(), 'docpilot-mcp-test-'));
  process.env.DOCPILOT_CACHE_DIR = tempCacheRoot;
});

function cleanup(): void {
  if (tempCacheRoot) {
    try {
      rmSync(tempCacheRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  delete process.env.DOCPILOT_CACHE_DIR;
}

function makeDeps(
  fetchImpl: () => Promise<FetchedPage>,
): Parameters<typeof handleQueryDocs>[1] {
  return {
    resolveDocsUrl: () => stripeFixturePage.url,
    fetchPage: fetchImpl,
    loadChunks: async (ecosystem, pkg, version) => {
      return loadChunks(ecosystem, pkg, version);
    },
    saveChunks: async (ecosystem, pkg, version, chunks) => {
      await saveChunks(ecosystem, pkg, version, chunks);
    },
  };
}

describe('AC-3: query_docs — version-accurate, cited, ranked context block', () => {
  it('returns the documented output shape with a snippet containing a literal docs phrase', async () => {
    let fetchCalls = 0;
    const deps = makeDeps(async () => {
      fetchCalls++;
      return stripeFixturePage;
    });

    const out = await handleQueryDocs(baseArgs, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const { result } = out;
    expect(result.package).toBe('stripe');
    expect(result.version).toBe(STRIPE_VERSION);

    // AC-3: top result's snippet must contain a literal phrase from
    // the package's own docs. The stripe-node SDK exposes
    // `auto_pagination_iter` for cursor walks.
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].snippet).toMatch(/auto_pagination_iter/);

    // AC-3: answer_markdown must end with a Sources: list and link
    // each sources[].url.
    expect(result.answer_markdown).toMatch(/\nSources:\n/);
    const sourcesBlock = result.answer_markdown.split(/\nSources:\n/)[1] ?? '';
    for (const src of result.sources) {
      expect(sourcesBlock).toContain(src.url);
    }

    // AC-3: ≤ 2000 tokens (whitespace-delimited approximation)
    const tokenCount = result.answer_markdown.split(/\s+/).length;
    expect(tokenCount).toBeLessThanOrEqual(2000);

    // The answer_markdown itself should also echo the literal phrase
    // since the top chunk is included in the body.
    expect(result.answer_markdown).toContain('auto_pagination_iter');

    // Network was hit exactly once on the first call.
    expect(fetchCalls).toBe(1);

    cleanup();
  });

  it('serves the second call from cache and logs cache=hit on stderr', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls++;
      return stripeFixturePage;
    };

    // First call: cache miss, fetch happens, chunks are persisted.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = await handleQueryDocs(baseArgs, makeDeps(fetchImpl));
      expect(first.ok).toBe(true);
      const errAfterFirst = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(errAfterFirst).toMatch(/cache=miss/);

      // Second call: identical args. If the cache was persisted by
      // the first call, the second call MUST NOT touch the network.
      const second = await handleQueryDocs(baseArgs, {
        resolveDocsUrl: () => stripeFixturePage.url,
        fetchPage: async () => {
          throw new Error('network must not be hit on cache hit');
        },
        loadChunks: async (ecosystem, pkg, version) => {
          return loadChunks(ecosystem, pkg, version);
        },
        saveChunks: async (ecosystem, pkg, version, chunks) => {
          await saveChunks(ecosystem, pkg, version, chunks);
        },
      });
      expect(second.ok).toBe(true);
      const errAfterSecond = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(errAfterSecond).toMatch(/cache=hit/);
      // The network must not have been hit on the second call.
      expect(fetchCalls).toBe(1);
    } finally {
      errSpy.mockRestore();
      cleanup();
    }
  });

  it('produces a deterministic ranking: the auto-pagination section wins over cursor/methods sections', () => {
    const chunks: Chunk[] = chunkText(stripeFixturePage.text, stripeFixturePage.url);
    expect(chunks.length).toBeGreaterThan(0);

    const top = rankChunks(chunks, baseArgs.question, { topK: 3 });
    expect(top.length).toBeGreaterThan(0);
    // The "Auto-pagination" section should outrank "Manual cursor
    // pagination" for a "how do I paginate cursor results" question
    // — and the top chunk must contain the literal
    // `auto_pagination_iter` phrase.
    expect(top[0].chunk.text).toContain('auto_pagination_iter');
  });

  it('persists and reloads chunks for a (package, version) under the temp cache root', async () => {
    const chunks: Chunk[] = chunkText(stripeFixturePage.text, stripeFixturePage.url);
    await saveChunks('npm', 'stripe', STRIPE_VERSION, chunks);
    expect(hasChunks('npm', 'stripe', STRIPE_VERSION)).toBe(true);
    const loaded = await loadChunks('npm', 'stripe', STRIPE_VERSION);
    expect(loaded?.length).toBe(chunks.length);
    cleanup();
  });
});
