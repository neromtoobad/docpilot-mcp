/**
 * Persisted chunk cache.
 *
 * Per AC-3 / AC-7: chunks for a (package, version) live at
 * `$CACHE_ROOT/index/<ecosystem>/<package>/<version>/chunks.jsonl` as
 * one JSON object per line. Writes are atomic (write to `*.tmp` then
 * rename). Reads tolerate a missing file (returns null).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { chunksPath, rawPath, type Ecosystem } from '../cache/paths.js';
import type { Chunk } from '../extractors/markdownChunks.js';

/** Load chunks for a (package, version) or null if no cache exists. */
export async function loadChunks(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<Chunk[] | null> {
  const path = chunksPath(ecosystem, pkg, version);
  if (!existsSync(path)) return null;
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const chunks: Chunk[] = [];
  for (const line of lines) {
    try {
      chunks.push(JSON.parse(line) as Chunk);
    } catch {
      // Tolerate a partially-written line; skip it.
    }
  }
  return chunks;
}

/** Atomically persist chunks for a (package, version). */
export async function saveChunks(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  chunks: Chunk[],
): Promise<void> {
  const path = chunksPath(ecosystem, pkg, version);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

/** Whether a chunk cache exists for this (package, version). */
export function hasChunks(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): boolean {
  return existsSync(chunksPath(ecosystem, pkg, version));
}

/** Persist a raw page (e.g. fetched HTML) under `raw/`. */
export async function saveRaw(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  filename: string,
  content: string,
): Promise<string> {
  const path = rawPath(ecosystem, pkg, version, filename);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
  return path;
}

/** Load a previously-saved raw page, or null if not cached. */
export async function loadRaw(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  filename: string,
): Promise<string | null> {
  const path = rawPath(ecosystem, pkg, version, filename);
  if (!existsSync(path)) return null;
  return await readFile(path, 'utf8');
}
