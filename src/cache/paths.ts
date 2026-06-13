/**
 * Content-addressed cache paths.
 *
 * Layout (per AC-7 cache-format sketch):
 *
 *   $DOCPILOT_CACHE_DIR/                 (default: ~/.cache/docpilot-mcp)
 *     index/<ecosystem>/<package>/<version>/
 *       chunks.jsonl                     # one chunk per line
 *     raw/<ecosystem>/<package>/<version>/
 *       <source>.html                    # cached page HTML
 *
 * AC-3 uses this to (a) skip refetching docs that are already on disk
 * and (b) guarantee the second call is served from cache, per the
 * AC-3 cache=hit verification.
 *
 * `cacheRoot()` is a function (not a const) so tests can override
 * `DOCPILOT_CACHE_DIR` per-test and the new value takes effect
 * immediately for every consumer.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Ecosystem = 'npm' | 'pypi';

const DEFAULT_ROOT = join(homedir(), '.cache', 'docpilot-mcp');

/** Root of the entire docpilot-mcp cache tree. Overridable via env. */
export function cacheRoot(): string {
  return process.env.DOCPILOT_CACHE_DIR ?? DEFAULT_ROOT;
}

/** Directory that holds the per-(package, version) index files. */
export function indexDir(ecosystem: Ecosystem, pkg: string, version: string): string {
  return join(cacheRoot(), 'index', ecosystem, pkg, version);
}

/** Directory that holds the raw page HTML per-(package, version). */
export function rawDir(ecosystem: Ecosystem, pkg: string, version: string): string {
  return join(cacheRoot(), 'raw', ecosystem, pkg, version);
}

/** Path to the per-(package, version) chunks file. */
export function chunksPath(ecosystem: Ecosystem, pkg: string, version: string): string {
  return join(indexDir(ecosystem, pkg, version), 'chunks.jsonl');
}

/** Path to a cached page under `raw/`. */
export function rawPath(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
  filename: string,
): string {
  return join(rawDir(ecosystem, pkg, version), filename);
}

