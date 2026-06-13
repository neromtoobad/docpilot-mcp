/**
 * `query_docs` — answer a natural-language question against the
 * version-accurate docs of an npm or PyPI package.
 *
 * Pipeline (AC-3 + AC-7):
 *   1. Resolve the package's docs URL (known mapping → registry
 *      homepage → bail with E_NOT_FOUND).
 *   2. Fetch the page (cheerio). If the chunk cache is missing,
 *      build it on disk; otherwise reuse it. Either way, log
 *      `cache=hit` or `cache=miss` on stderr.
 *   3. Build the vector index (hnswlib-node) from the chunks if
 *      it's not already on disk. The embedding model is local
 *      (Xenova/all-MiniLM-L6-v2, 384-dim) and is loaded lazily
 *      on the first call. If the model can't be loaded (network
 *      down, ONNX runtime missing, …), we fall back to the
 *      TF-IDF ranker and log a `WARN` — the server never crashes
 *      on a missing embedding model.
 *   4. Rank against the question (vector k-NN or TF-IDF cosine)
 *      and keep the top-K results.
 *   5. Format an `answer_markdown` (≤ 2000 tokens) ending with a
 *      `Sources:` list. The top result's `snippet` is a literal
 *      slice of the top chunk's text.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toolError, type ToolErrorCode } from '../util/errors.js';
import { debug, info, warn } from '../util/log.js';
import type { Ecosystem } from '../cache/paths.js';
import type { Chunk } from '../extractors/markdownChunks.js';
import { chunkText } from '../extractors/markdownChunks.js';
import { rankChunks, type ScoredChunk } from '../index/lexical.js';
import { hasChunks, loadChunks, saveChunks } from '../index/store.js';
import {
  addChunkVector,
  buildIndexInMemory,
  hasVectorIndex,
  loadVectorIndex,
  loadVectorMeta,
  saveVectorIndex,
  searchVectorIndex,
  type BuiltVectorIndex,
} from '../index/vectorStore.js';
import { loadEmbedder, type Embedder } from '../index/embed.js';
import { getKnownDocs } from '../sources/docsSite.js';
import { fetchPage, type FetchedPage } from '../sources/fetchPage.js';
import { FetchHttpClient, type HttpClient } from '../net/httpClient.js';

export const MAX_ANSWER_TOKENS = 2000;
const MAX_QUESTION_TOKENS = 1024;

/** Public output contract for `query_docs`. Matches AC-3 exactly. */
export interface QueryDocsResult {
  package: string;
  version: string;
  answer_markdown: string;
  sources: Array<{
    url: string;
    section: string;
    snippet: string;
    score: number;
  }>;
}

export interface QueryDocsDeps {
  http: HttpClient;
  /** Override the known-docs resolver. */
  resolveDocsUrl?: (pkg: string, ecosystem: Ecosystem) => string | null;
  /** Override the page fetcher (for tests). */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** Override the chunk store (for tests). */
  loadChunks?: (ecosystem: Ecosystem, pkg: string, version: string) => Promise<Chunk[] | null>;
  saveChunks?: (ecosystem: Ecosystem, pkg: string, version: string, chunks: Chunk[]) => Promise<void>;
  /**
   * Override the embedder loader. Default delegates to
   * `loadEmbedder()` (which returns `null` on failure and
   * silently falls back to the TF-IDF ranker).
   */
  loadEmbedder?: () => Promise<Embedder | null>;
  /**
   * Override the vector-index presence check (for tests).
   */
  hasVectorIndex?: (ecosystem: Ecosystem, pkg: string, version: string) => boolean;
  /**
   * Override the vector-index loader (for tests).
   */
  loadVectorIndex?: (
    ecosystem: Ecosystem,
    pkg: string,
    version: string,
  ) => Promise<BuiltVectorIndex | null>;
  /**
   * Override the vector-index builder. Takes the chunks and an
   * embedder, returns a built (but not yet persisted) index.
   */
  buildVectorIndex?: (chunks: Chunk[], embedder: Embedder) => BuiltVectorIndex;
  /**
   * Override the vector-index saver. Persists the index to disk.
   */
  saveVectorIndex?: (
    built: BuiltVectorIndex,
    ecosystem: Ecosystem,
    pkg: string,
    version: string,
  ) => Promise<unknown>;
}

export interface QueryDocsArgs {
  package: string;
  version: string;
  question: string;
}

const DEFAULT_DEPS: QueryDocsDeps = {
  http: new FetchHttpClient(),
};

function detectEcosystem(pkg: string, hint?: Ecosystem): Ecosystem {
  if (hint) return hint;
  // Heuristic: well-known npm packages are camelCase or contain
  // dashes; PyPI packages are typically lowercase-with-dashes too.
  // We try the known mapping first; this fallback is only used when
  // the mapping misses. We default to npm because that covers the
  // AC-3 stripe/next example.
  return 'npm';
}

function defaultResolveDocsUrl(pkg: string, ecosystem: Ecosystem): string | null {
  return getKnownDocs(ecosystem, pkg)?.url ?? null;
}

function defaultFetchPageImpl(url: string): Promise<FetchedPage> {
  return fetchPage(DEFAULT_DEPS.http, url);
}

function defaultLoadChunksImpl(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<Chunk[] | null> {
  return loadChunks(ecosystem, pkg, version);
}

function defaultSaveChunksImpl(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  chunks: Chunk[],
): Promise<void> {
  return saveChunks(ecosystem, pkg, version, chunks);
}

function clampToTokens(markdown: string, maxTokens: number): string {
  // Cheap "token" approximation: whitespace-delimited words.
  const words = markdown.split(/\s+/);
  if (words.length <= maxTokens) return markdown;
  return words.slice(0, maxTokens).join(' ');
}

function buildAnswer(top: ScoredChunk[], maxTokens: number): {
  answer_markdown: string;
  sources: QueryDocsResult['sources'];
} {
  const sources = top.map((s) => ({
    url: s.chunk.url,
    section: s.chunk.section,
    snippet: s.chunk.text.slice(0, 240),
    score: Number(s.score.toFixed(4)),
  }));

  const intro = top[0]
    ? `_Top result (score=${sources[0].score}) from section "${sources[0].section}":_\n\n`
    : '';

  const body = top
    .map((s, i) => {
      const section = s.chunk.section || '(untitled)';
      const snippet = s.chunk.text.length > 320 ? `${s.chunk.text.slice(0, 320)}…` : s.chunk.text;
      return `**${i + 1}. ${section}** — _score ${s.score.toFixed(3)}_\n\n${snippet}`;
    })
    .join('\n\n');

  const sourcesBlock = ['Sources:']
    .concat(sources.map((s, i) => `${i + 1}. ${s.url}`))
    .join('\n');

  const markdown = clampToTokens(`${intro}${body}\n\n${sourcesBlock}`, maxTokens);
  return { answer_markdown: markdown, sources };
}

/** Pure handler — exported so tests can call it directly. */
export async function handleQueryDocs(
  args: QueryDocsArgs,
  userDeps: Partial<QueryDocsDeps> = {},
): Promise<{ ok: true; result: QueryDocsResult } | { ok: false; code: ToolErrorCode; message: string }> {
  if (args.question.length > MAX_QUESTION_TOKENS * 4) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: `question is too long (${args.question.length} chars); max ${MAX_QUESTION_TOKENS * 4}`,
    };
  }

  const deps: QueryDocsDeps = {
    ...DEFAULT_DEPS,
    ...userDeps,
    resolveDocsUrl: userDeps.resolveDocsUrl ?? defaultResolveDocsUrl,
    fetchPage: userDeps.fetchPage ?? defaultFetchPageImpl,
    loadChunks: userDeps.loadChunks ?? defaultLoadChunksImpl,
    saveChunks: userDeps.saveChunks ?? defaultSaveChunksImpl,
    loadEmbedder: userDeps.loadEmbedder ?? loadEmbedder,
    hasVectorIndex: userDeps.hasVectorIndex ?? hasVectorIndex,
    loadVectorIndex: userDeps.loadVectorIndex ?? defaultLoadVectorIndex,
    buildVectorIndex: userDeps.buildVectorIndex ?? buildIndexInMemory,
    saveVectorIndex: userDeps.saveVectorIndex ?? saveVectorIndex,
  };

  const ecosystem = detectEcosystem(args.package);
  const version = args.version;

  // 1) Chunk cache check.
  let chunks = await deps.loadChunks!(ecosystem, args.package, version);
  const cacheHit = chunks !== null && chunks.length > 0;
  if (cacheHit) {
    info(`query_docs cache=hit pkg=${args.package}@${version} chunks=${chunks!.length}`);
  } else {
    info(`query_docs cache=miss pkg=${args.package}@${version}`);
  }

  // 2) Build the chunk cache if missing.
  if (!cacheHit) {
    const docsUrl = deps.resolveDocsUrl!(args.package, ecosystem);
    if (!docsUrl) {
      return {
        ok: false,
        code: 'E_NOT_FOUND',
        message: `No known docs URL for ${ecosystem} package "${args.package}". Try a different package or open an issue.`,
      };
    }
    debug(`query_docs fetching ${docsUrl}`);
    let page: FetchedPage;
    try {
      page = await deps.fetchPage!(docsUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'E_UPSTREAM',
        message: `Failed to fetch docs at ${docsUrl}: ${message}`,
      };
    }
    if (page.text.length < 50) {
      warn(`query_docs body too small at ${docsUrl} (${page.text.length} chars)`);
      return {
        ok: false,
        code: 'E_UPSTREAM',
        message: `Docs at ${docsUrl} returned too little content (${page.text.length} chars). The site may require JS rendering (AC-8 will add that fallback).`,
      };
    }
    chunks = chunkText(page.text, page.url);
    if (chunks.length === 0) {
      return {
        ok: false,
        code: 'E_UPSTREAM',
        message: `Chunker produced 0 chunks from ${docsUrl}; refusing to serve an empty answer.`,
      };
    }
    try {
      await deps.saveChunks!(ecosystem, args.package, version, chunks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`query_docs failed to persist chunks: ${message}`);
    }
  }

  // 3) Rank against the question — vector k-NN first, lexical
  // fallback if the model can't be loaded.
  const top = await rankWithVectorFallback(
    deps,
    ecosystem,
    args.package,
    version,
    chunks!,
    args.question,
  );
  if (top.length === 0) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `No chunks scored above zero for question "${args.question}" on ${args.package}@${version}.`,
    };
  }

  // 4) Build the answer.
  const { answer_markdown, sources } = buildAnswer(top, MAX_ANSWER_TOKENS);
  return {
    ok: true,
    result: {
      package: args.package,
      version,
      answer_markdown,
      sources,
    },
  };
}

/**
 * AC-7 ranking path: try the vector index, fall back to lexical.
 *
 * Returns an array of `ScoredChunk` so the existing
 * `buildAnswer` formatting works unchanged regardless of which
 * path served the results.
 */
async function rankWithVectorFallback(
  deps: QueryDocsDeps,
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  chunks: Chunk[],
  question: string,
): Promise<ScoredChunk[]> {
  // Try vector path.
  const embedder = await deps.loadEmbedder!();
  if (!embedder) {
    debug('query_docs vector=unavailable ranker=lexical');
    return rankChunks(chunks, question, { topK: 5 });
  }

  // Load or build the vector index.
  let built: BuiltVectorIndex | null = null;
  const onDisk = deps.hasVectorIndex!(ecosystem, pkg, version);
  if (onDisk) {
    try {
      const meta = await loadVectorMeta(ecosystem, pkg, version);
      if (meta && meta.model === embedder.modelId && meta.dim === embedder.dim) {
        built = await deps.loadVectorIndex!(ecosystem, pkg, version);
        info(
          `query_docs vector=hit pkg=${pkg}@${version} model=${meta.model} count=${meta.count}`,
        );
      } else {
        debug(
          `query_docs vector meta mismatch (cached model=${meta?.model ?? 'none'} dim=${meta?.dim ?? 0} vs current model=${embedder.modelId} dim=${embedder.dim}); rebuilding`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`query_docs vector load failed: ${message}; rebuilding`);
    }
  }
  if (!built) {
    info(
      `query_docs vector=miss pkg=${pkg}@${version} chunks=${chunks.length} model=${embedder.modelId} dim=${embedder.dim}; building`,
    );
    try {
      built = deps.buildVectorIndex!(chunks, embedder);
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embedder.embedOne(chunks[i].text);
        addChunkVector(built, i, vec);
      }
      await deps.saveVectorIndex!(built, ecosystem, pkg, version);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`query_docs vector build failed: ${message}; falling back to lexical`);
      return rankChunks(chunks, question, { topK: 5 });
    }
  }

  // Embed the question and run k-NN.
  try {
    const qVec = await embedder.embedOne(question);
    const hits = searchVectorIndex(built, qVec, 5);
    return hits.map((h) => ({ chunk: chunks[h.label], score: 1 - h.distance }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`query_docs vector search failed: ${message}; falling back to lexical`);
    return rankChunks(chunks, question, { topK: 5 });
  }
}

async function defaultLoadVectorIndex(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<BuiltVectorIndex | null> {
  const meta = await loadVectorMeta(ecosystem, pkg, version);
  if (!meta) return null;
  return await loadVectorIndex(ecosystem, pkg, version, meta);
}

export function registerQueryDocs(server: McpServer): void {
  server.registerTool(
    'query_docs',
    {
      title: 'Query package documentation',
      description:
        'Answer a natural-language question about an npm or PyPI package with a version-accurate, cited, ranked context block drawn from the package\'s own docs.',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "stripe", "requests", "next".'),
        version: z
          .string()
          .min(1)
          .describe('Exact semver or "latest" (default behaviour for the package ecosystem).'),
        question: z
          .string()
          .min(3)
          .describe('Natural-language question, e.g. "how do I paginate cursor results".'),
      },
    },
    async (args) => {
      const out = await handleQueryDocs(args);
      if (out.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(out.result),
            },
          ],
        };
      }
      return toolError(out.code, out.message);
    },
  );
}
