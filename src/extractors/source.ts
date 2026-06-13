/**
 * Download + extract the source code for an npm or PyPI package.
 *
 * Per AC-6:
 *   - TypeScript/JS: pull the tarball via `dist.tarball`, extract
 *     all `.d.ts` files. (The plan calls for ".d.ts in the
 *     tarball" — that's the public surface shipped with every
 *     `types`-aware npm release.)
 *   - Python: pull the wheel for the requested version, extract
 *     `.pyi` stubs first, falling back to `.py` source. Wheel
 *     URLs come from PyPI's `releases[version][].url`.
 *
 * Both flows download into a temp directory, extract, read the
 * files we care about into memory, and return a `Map<path,
 * content>`. The temp directory is cleaned up on the way out.
 *
 * This module is the only I/O-heavy piece of the AC-6 handler;
 * the rest operates on in-memory source blobs.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Buffer } from 'node:buffer';

import { FetchHttpClient, HttpError, type HttpClient } from '../net/httpClient.js';
import type { NpmPackageInfo, NpmVersionInfo } from '../sources/registry/npm.js';
import type { PypiPackageInfo } from '../sources/registry/pypi.js';

export type ExtractedFileMap = Map<string, string>;

/**
 * Resolve the requested version against the registry's version
 * map. For `latest`, we use the npm `dist-tags.latest` (already
 * resolved by `entriesFromNpm` upstream) or the PyPI `info.version`.
 */
export function resolveNpmVersion(info: NpmPackageInfo, versionSpec: string): string {
  if (versionSpec !== 'latest') return versionSpec;
  return (
    info['dist-tags']?.latest ??
    Object.keys(info.versions ?? {}).slice(-1)[0] ??
    versionSpec
  );
}

export function resolvePypiVersion(info: PypiPackageInfo, versionSpec: string): string {
  if (versionSpec !== 'latest') return versionSpec;
  return info.info.version ?? versionSpec;
}

function findNpmVersionEntry(
  info: NpmPackageInfo,
  resolved: string,
): NpmVersionInfo | null {
  return info.versions?.[resolved] ?? null;
}

function findPypiWheelUrl(info: PypiPackageInfo, resolved: string): string | null {
  const files = info.releases?.[resolved] ?? [];
  // Prefer the wheel; fall back to sdist; fall back to the first
  // available file.
  const wheel = files.find((f) => f.filename.endsWith('.whl'));
  if (wheel?.url) return wheel.url;
  const sdist = files.find((f) => f.filename.endsWith('.tar.gz'));
  if (sdist?.url) return sdist.url;
  return files[0]?.url ?? null;
}

/**
 * Download + extract the `.d.ts` files for an npm version. The
 * result is a map of repo-relative path (e.g. `types/Customers.d.ts`)
 * to file content. Returns `null` if the tarball couldn't be
 * fetched or extracted.
 */
export async function loadNpmDts(
  http: HttpClient,
  info: NpmPackageInfo,
  versionSpec: string,
): Promise<ExtractedFileMap | null> {
  const resolved = resolveNpmVersion(info, versionSpec);
  const entry = findNpmVersionEntry(info, resolved);
  if (!entry) return null;
  const tarball = entry.dist?.tarball;
  if (!tarball) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'docpilot-npm-'));
  try {
    const bytes = await downloadBytes(http, tarball);
    if (!bytes) return null;
    await extractTarGz(bytes, tmp);
    return collectFilesByExtension(tmp, ['.d.ts']);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`loadNpmDts: failed for ${tarball}: ${message}\n`);
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Download + extract `.pyi` stubs (preferred) and `.py` source
 * (fallback) for a PyPI version. Returns `null` if no wheel/sdist
 * was found or extraction failed.
 */
export async function loadPyStubsAndSource(
  http: HttpClient,
  info: PypiPackageInfo,
  versionSpec: string,
): Promise<ExtractedFileMap | null> {
  const resolved = resolvePypiVersion(info, versionSpec);
  const url = findPypiWheelUrl(info, resolved);
  if (!url) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'docpilot-pypi-'));
  try {
    const bytes = await downloadBytes(http, url);
    if (!bytes) return null;
    if (url.endsWith('.whl')) {
      await extractZip(bytes, tmp);
    } else if (url.endsWith('.tar.gz')) {
      await extractTarGz(bytes, tmp);
    } else {
      return null;
    }
    const pyi = collectFilesByExtension(tmp, ['.pyi']);
    if (pyi.size > 0) return pyi;
    // Fall back to .py source per the plan ("when the wheel's .pyi
    // stubs are absent, walk the .py source").
    return collectFilesByExtension(tmp, ['.py']);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`loadPyStubsAndSource: failed for ${url}: ${message}\n`);
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function downloadBytes(http: HttpClient, url: string): Promise<Buffer | null> {
  // The HttpClient we ship is text-only; for tarball/wheel
  // downloads we need raw bytes. The npm registry and PyPI
  // return gzipped/binary for tarball/wheel endpoints, so we
  // route through `fetch` directly here.
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new HttpError(
        `HTTP ${res.status} ${res.statusText} for ${url}`,
        res.status,
        url,
      );
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`downloadBytes ${url}: ${message}\n`);
    return null;
  }
}

/** Spawn `tar -xzf` to extract a gzipped tarball into `dir`. */
async function extractTarGz(bytes: Buffer, dir: string): Promise<void> {
  const r = spawnSync('tar', ['-xzf', '-', '-C', dir], {
    input: bytes,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const message = (r.stderr ?? Buffer.from('')).toString('utf8');
    throw new Error(`tar extraction failed: ${message.split('\n')[0]}`);
  }
}

/** Spawn `unzip` to extract a zip into `dir`. */
async function extractZip(bytes: Buffer, dir: string): Promise<void> {
  const r = spawnSync('unzip', ['-q', '-o', '-d', dir, '-'], {
    input: bytes,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    // Some sandboxes block `unzip`; fall back to Python's
    // `zipfile` (always available since we depend on it for
    // signature extraction anyway).
    const fallback = spawnSync(
      'python3',
      [
        '-c',
        'import sys, zipfile, io; zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).extractall(sys.argv[1])',
        dir,
      ],
      { input: bytes, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
    );
    if (fallback.status !== 0) {
      const message = (r.stderr ?? Buffer.from('')).toString('utf8');
      throw new Error(`unzip extraction failed: ${message.split('\n')[0]}`);
    }
  }
}

/**
 * Walk `dir` and collect every file with one of the requested
 * extensions, keyed by path relative to `dir`. The relative key
 * is what the AC-6 `source.path` field exposes.
 */
function collectFilesByExtension(
  dir: string,
  extensions: string[],
): ExtractedFileMap {
  const out: ExtractedFileMap = new Map();
  const wanted = new Set(extensions);
  // `find ... -print0` is the safest way to handle filenames
  // with spaces, parens, etc. We rely on GNU find being present
  // (standard on Linux; macOS needs `brew install findutils` —
  // we ship a python fallback below for that case).
  const r = spawnSync(
    'find',
    [
      dir,
      '-type', 'f',
      '(', ...extensions.flatMap((e, i) => (i === 0 ? ['-name', `*${e}`] : ['-o', '-name', `*${e}`])), ')',
      '-print0',
    ],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    // Fall back to Python's os.walk.
    const fb = spawnSync(
      'python3',
      [
        '-c',
        'import os, sys\nfor root, _, files in os.walk(sys.argv[1]):\n  for f in files:\n    print(os.path.join(root, f))\n',
        dir,
      ],
      { encoding: 'utf8' },
    );
    if (fb.status === 0) {
      for (const line of (fb.stdout ?? '').split('\n')) {
        if (!line) continue;
        tryCollect(line, dir, wanted, out);
      }
    }
    return out;
  }
  const stdout = r.stdout ?? Buffer.from('');
  let start = 0;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === 0) {
      const path = stdout.slice(start, i).toString('utf8');
      start = i + 1;
      tryCollect(path, dir, wanted, out);
    }
  }
  if (start < stdout.length) {
    tryCollect(stdout.slice(start).toString('utf8'), dir, wanted, out);
  }
  return out;
}

function tryCollect(
  fullPath: string,
  root: string,
  wanted: Set<string>,
  out: ExtractedFileMap,
): void {
  // Multi-segment extensions like `.d.ts` have two dots; match
  // against the longest wanted suffix, not the trailing slice.
  for (const ext of wanted) {
    if (fullPath.endsWith(ext)) {
      try {
        const rel = relative(root, fullPath) || fullPath;
        out.set(rel, readFileSync(fullPath, 'utf8'));
      } catch (e) {
        process.stderr.write(`[tryCollect] readFileSync failed for ${fullPath}: ${(e as Error).message}\n`);
      }
      return;
    }
  }
}

/** Convenience: a default HTTP client for the I/O layer. */
export const defaultSourceHttpClient: HttpClient = new FetchHttpClient();
