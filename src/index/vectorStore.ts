/**
 * hnswlib-node vector store, persisted to `$CACHE_ROOT/index/.../vector.bin`
 * alongside `chunks.jsonl` (AC-7).
 *
 * The on-disk format is:
 *   - `vector.bin`     : hnswlib-native binary index (HNSW graph)
 *   - `vector-meta.json`: { model, dim, m, efConstruction, efSearch, count }
 *
 * `vector-meta.json` is the contract: if its `{ model, dim }` fields
 * don't match the current server's expectations, we rebuild the
 * index from `chunks.jsonl`. This lets the server upgrade the model
 * without crashing on old caches.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import hnswlib from 'hnswlib-node';

import {
  vectorIndexPath,
  vectorMetaPath,
  type Ecosystem,
} from '../cache/paths.js';
import type { Chunk } from '../extractors/markdownChunks.js';
import type { Embedder } from './embed.js';
import { info, warn } from '../util/log.js';

export interface VectorIndexMeta {
  /** Model identifier (e.g. `Xenova/all-MiniLM-L6-v2`). */
  model: string;
  /** Embedding dimensionality. */
  dim: number;
  /** hnswlib-node `M` parameter (max outgoing connections). */
  m: number;
  /** hnswlib-node `efConstruction` parameter. */
  efConstruction: number;
  /** hnswlib-node `efSearch` parameter. */
  efSearch: number;
  /** Number of vectors in the index. */
  count: number;
  /** Wall-clock ISO timestamp of the build. */
  builtAt: string;
}

export interface BuiltVectorIndex {
  meta: VectorIndexMeta;
  /** File path of the persisted `vector.bin`. */
  path: string;
  /** The hnswlib handle. Caller is responsible for freeing on teardown. */
  handle: hnswlib.HierarchicalNSW;
}

const DEFAULT_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_EF_SEARCH = 50;

/** Build a fresh in-memory index from a list of chunks. */
export function buildIndexInMemory(
  chunks: Chunk[],
  embedder: Embedder,
  options: { m?: number; efConstruction?: number; efSearch?: number } = {},
): BuiltVectorIndex {
  const m = options.m ?? DEFAULT_M;
  const efConstruction = options.efConstruction ?? DEFAULT_EF_CONSTRUCTION;
  const efSearch = options.efSearch ?? DEFAULT_EF_SEARCH;
  const handle = new hnswlib.HierarchicalNSW('cosine', embedder.dim);
  handle.initIndex(Math.max(chunks.length, 1), m, efConstruction);
  return {
    handle,
    meta: {
      model: embedder.modelId,
      dim: embedder.dim,
      m,
      efConstruction,
      efSearch,
      count: 0, // updated as we add
      builtAt: new Date().toISOString(),
    },
    path: '', // populated by save
  };
}

/** Add a single (chunk, vector) pair to the index. */
export function addChunkVector(
  built: BuiltVectorIndex,
  label: number,
  vector: Float32Array,
): void {
  built.handle.addPoint(Array.from(vector), label);
  built.meta.count = label + 1;
}

/**
 * Persist the index to `vector.bin` and write `vector-meta.json`.
 * The handle is left in memory; caller can keep using it.
 */
export async function saveVectorIndex(
  built: BuiltVectorIndex,
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<{ indexPath: string; metaPath: string }> {
  const indexPath = vectorIndexPath(ecosystem, pkg, version);
  const metaPath = vectorMetaPath(ecosystem, pkg, version);
  await mkdir(dirname(indexPath), { recursive: true });
  const indexTmp = `${indexPath}.tmp`;
  const metaTmp = `${metaPath}.tmp`;
  await built.handle.writeIndex(indexTmp);
  // writeIndex is async; await it via the promise interface.
  await rename(indexTmp, indexPath);
  await writeFile(metaTmp, JSON.stringify(built.meta, null, 2), 'utf8');
  await rename(metaTmp, metaPath);
  built.path = indexPath;
  info(
    `vector store ecosystem=${ecosystem} pkg=${pkg}@${version} saved count=${built.meta.count} dim=${built.meta.dim} model=${built.meta.model}`,
  );
  return { indexPath, metaPath };
}

/** Read `vector-meta.json` and return it, or `null` if the cache is missing. */
export async function loadVectorMeta(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<VectorIndexMeta | null> {
  const metaPath = vectorMetaPath(ecosystem, pkg, version);
  if (!existsSync(metaPath)) return null;
  try {
    const text = await readFile(metaPath, 'utf8');
    return JSON.parse(text) as VectorIndexMeta;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`loadVectorMeta failed for ${metaPath}: ${message}`);
    return null;
  }
}

/** Whether both `vector.bin` and `vector-meta.json` are present. */
export function hasVectorIndex(ecosystem: Ecosystem, pkg: string, version: string): boolean {
  return (
    existsSync(vectorIndexPath(ecosystem, pkg, version)) &&
    existsSync(vectorMetaPath(ecosystem, pkg, version))
  );
}

/** Load the persisted index back into memory. */
export async function loadVectorIndex(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  meta: VectorIndexMeta,
): Promise<BuiltVectorIndex> {
  const indexPath = vectorIndexPath(ecosystem, pkg, version);
  const handle = new hnswlib.HierarchicalNSW('cosine', meta.dim);
  await handle.readIndex(indexPath);
  return { handle, meta, path: indexPath };
}

/**
 * Run a k-NN query against an in-memory index. Returns the
 * matching `(label, distance)` pairs sorted by distance ascending.
 */
export function searchVectorIndex(
  built: BuiltVectorIndex,
  queryVec: Float32Array,
  k: number,
): Array<{ label: number; distance: number }> {
  const { distances, neighbors } = built.handle.searchKnn(
    Array.from(queryVec),
    Math.min(k, built.meta.count || k),
  );
  const out: Array<{ label: number; distance: number }> = [];
  for (let i = 0; i < neighbors.length; i++) {
    out.push({ label: neighbors[i], distance: distances[i] });
  }
  return out;
}
