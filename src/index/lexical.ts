/**
 * TF-IDF lexical ranker.
 *
 * AC-3's offline test asserts that the top result's snippet contains a
 * literal phrase from the package's docs. The simplest ranker that
 * satisfies that is TF-IDF cosine similarity over a bag-of-words model.
 *
 * The full embedding + hnswlib vector index lands in AC-7. We keep
 * this ranker around as a deterministic, dependency-free fallback
 * that the vector store can also delegate to when the model fails to
 * load (per the plan's "lexical fallback" risk control).
 */
import type { Chunk } from '../extractors/markdownChunks.js';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/** English stop words — keep this list short and obviously correct. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your', 'i', 'we',
  'do', 'does', 'how', 'what', 'which', 'when', 'where', 'who', 'why',
]);

/** Tokenize for TF-IDF: lowercase, drop punctuation, drop stop words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

type SparseVector = Map<string, number>;

/** Build a TF-IDF vector from a token list using the provided idf map. */
function vectorize(tokens: string[], idf: Map<string, number>): SparseVector {
  const counts = new Map<string, number>();
  for (const term of tokens) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const vec: SparseVector = new Map();
  for (const [term, count] of counts) {
    const weight = idf.get(term) ?? 0;
    vec.set(term, count * weight);
  }
  return vec;
}

function cosine(a: SparseVector, b: SparseVector): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  // Iterate the smaller of the two for dot product.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, value] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += value * other;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface RankOptions {
  topK?: number;
}

/**
 * Rank `chunks` by relevance to `question` and return the top-K
 * results in descending score order.
 */
export function rankChunks(
  chunks: Chunk[],
  question: string,
  options: RankOptions = {},
): ScoredChunk[] {
  const topK = options.topK ?? 5;
  if (chunks.length === 0) return [];

  const queryTokens = tokenize(question);
  const docTokens = chunks.map((c) => tokenize(c.text));

  // Compute document frequency across (query ∪ docs).
  const df = new Map<string, number>();
  const all = [queryTokens, ...docTokens];
  for (const toks of all) {
    const seen = new Set(toks);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // IDF with smoothing: log((N+1) / (df+1)) + 1
  const N = all.length;
  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
  }

  const queryVec = vectorize(queryTokens, idf);
  const scored: ScoredChunk[] = docTokens.map((dt, i) => {
    const docVec = vectorize(dt, idf);
    return { chunk: chunks[i], score: cosine(queryVec, docVec) };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
