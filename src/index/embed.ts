/**
 * Local embedding model wrapper.
 *
 * AC-7 requires the vector index to be built from a *local* model
 * so the server works fully offline after the first model download.
 * The plan's "lexical fallback" risk control says:
 *
 *   "On `fetch` failure for the model, log a `WARN` and switch to
 *    lexical search for that session; never crash the server."
 *
 * That fallback is implemented here. `loadEmbedder()` returns
 * `null` when the model can't be loaded (network down, ONNX
 * runtime missing, native binding missing, …); callers then fall
 * back to the TF-IDF ranker in `lexical.ts`. The embedder is
 * cached behind a singleton with a load-promise so concurrent
 * callers don't all kick off a fresh model download.
 */
import { info, warn } from '../util/log.js';

export interface Embedder {
  /** Embedding dimensionality (384 for `all-MiniLM-L6-v2`). */
  dim: number;
  /** Identifier of the underlying model (e.g. `Xenova/all-MiniLM-L6-v2`). */
  modelId: string;
  /** Embed a single text into a `dim`-length Float32Array. */
  embedOne(text: string): Promise<Float32Array>;
  /** Embed a batch of texts. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/** Default model: small, fast, English-only, 384-dim. ~25 MB. */
export const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

interface LoaderState {
  promise: Promise<Embedder | null> | null;
  embedder: Embedder | null;
}

const state: LoaderState = {
  promise: null,
  embedder: null,
};

/**
 * Load the embedding model. Returns `null` on any failure (the
 * caller should fall back to lexical ranking). The result is
 * memoised process-wide.
 */
export function loadEmbedder(modelId: string = DEFAULT_MODEL_ID): Promise<Embedder | null> {
  if (state.embedder) return Promise.resolve(state.embedder);
  if (state.promise) return state.promise;
  state.promise = doLoad(modelId)
    .then((emb) => {
      state.embedder = emb;
      state.promise = null;
      return emb;
    })
    .catch((err) => {
      state.promise = null;
      const message = err instanceof Error ? err.message : String(err);
      warn(`embedder load failed: ${message}`);
      return null;
    });
  return state.promise;
}

/** Test-only: reset the cached embedder. */
export function resetEmbedderForTests(): void {
  state.embedder = null;
  state.promise = null;
}

async function doLoad(modelId: string): Promise<Embedder> {
  info(`embedder loading model=${modelId}`);
  // Dynamic import: the `@xenova/transformers` package is large
  // and we don't want it to block startup when the model can't
  // be reached.
  const transformers = await import('@xenova/transformers');
  const { env, pipeline } = transformers as unknown as {
    env: { cacheDir?: string; useFsCache?: boolean };
    pipeline: (task: string, model?: string) => Promise<unknown>;
  };
  if (env && process.env.DOCPILOT_EMBED_CACHE_DIR) {
    env.cacheDir = process.env.DOCPILOT_EMBED_CACHE_DIR;
  }
  const featureExtractor = (await pipeline('feature-extraction', modelId)) as (
    text: string,
    options?: { pooling?: 'mean' | 'cls'; normalize?: boolean },
  ) => Promise<{ data: Float32Array; dims: number[] }>;

  // Probe with a short string to discover the dimensionality and
  // make sure the model is actually loaded.
  const probe = await featureExtractor('probe', { pooling: 'mean', normalize: true });
  const dim = probe.data.length;
  if (dim === 0) {
    throw new Error('embedder probe returned zero-dim vector');
  }
  info(`embedder model=${modelId} dim=${dim} ready`);

  async function embedOne(text: string): Promise<Float32Array> {
    const out = await featureExtractor(text, { pooling: 'mean', normalize: true });
    return out.data;
  }
  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) {
      out.push(await embedOne(t));
    }
    return out;
  }

  return {
    dim,
    modelId,
    embedOne,
    embedBatch,
  };
}
