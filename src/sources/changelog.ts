/**
 * Changelog entry extraction.
 *
 * The npm and PyPI registries both expose `version` + `date` for every
 * release but neither embeds a per-release changelog. AC-4 requires
 * us to (1) read the version+date from the registry, then (2) when
 * summaries are missing fall back to fetching `CHANGELOG.md` from
 * the package's GitHub default branch and parse top-level headings.
 *
 * `entriesFromNpm` / `entriesFromPypi` produce `RegistryEntry[]`
 * (version + date, no summary). `entriesFromChangelogMd` produces
 * `ChangelogMdEntry[]` (version + date + summary) from a markdown
 * blob. `mergeSummaries` joins them on version so the caller can
 * always return the documented output shape.
 */
import type { NpmPackageInfo } from './registry/npm.js';
import type { PypiPackageInfo } from './registry/pypi.js';

export interface ChangelogEntry {
  version: string;
  date: string;
  summary: string;
}

export interface ChangelogMdEntry {
  version: string;
  date: string;
  summary: string;
}

const ENTRY_LIMIT = 10;

/**
 * Sort versions by date descending (newest first). Versions with no
 * date sink to the bottom.
 */
function byDateDesc(a: { date: string }, b: { date: string }): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return 0;
}

/** Resolve `version` against the package's `dist-tags`; return as-is when not 'latest'. */
export function resolveNpmVersion(info: NpmPackageInfo, versionSpec: string): string {
  if (versionSpec !== 'latest') return versionSpec;
  return info['dist-tags']?.latest ?? Object.keys(info.versions ?? {}).slice(-1)[0] ?? versionSpec;
}

/** Build a `version → date` map from the npm `time` field, ignoring metadata keys. */
export function npmTimeMap(info: NpmPackageInfo): Map<string, string> {
  const time = info.time ?? {};
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(time)) {
    if (k === 'created' || k === 'modified') continue;
    if (info.versions?.[k] == null) continue;
    out.set(k, v);
  }
  return out;
}

/**
 * Return the 10 most-recent npm releases (newest first). Each entry
 * carries `version` and `date` from the registry; `summary` is
 * filled in by `mergeSummaries` from a GitHub CHANGELOG.md later.
 */
export function entriesFromNpm(info: NpmPackageInfo, versionSpec: string): {
  resolved: string;
  entries: ChangelogEntry[];
} {
  const resolved = resolveNpmVersion(info, versionSpec);
  const time = npmTimeMap(info);
  const versions = Array.from(time.entries())
    .map(([version, date]) => ({
      version,
      date,
      summary: info.versions?.[version]?.description ?? '',
    }))
    .sort(byDateDesc)
    .slice(0, ENTRY_LIMIT);
  return { resolved, entries: versions };
}

/** Build a `version → date` map from PyPI's `releases` field. */
export function pypiTimeMap(info: PypiPackageInfo): Map<string, string> {
  const out = new Map<string, string>();
  for (const [version, files] of Object.entries(info.releases ?? {})) {
    if (!files || files.length === 0) continue;
    const sorted = [...files].sort((a, b) => a.upload_time.localeCompare(b.upload_time));
    out.set(version, sorted[0].upload_time);
  }
  return out;
}

/** Return the 10 most-recent PyPI releases (newest first). No summaries from PyPI. */
export function entriesFromPypi(info: PypiPackageInfo, versionSpec: string): {
  resolved: string;
  entries: ChangelogEntry[];
} {
  const resolved = versionSpec === 'latest' ? info.info.version : versionSpec;
  const time = pypiTimeMap(info);
  const versions = Array.from(time.entries())
    .map(([version, date]) => ({ version, date, summary: '' }))
    .sort(byDateDesc)
    .slice(0, ENTRY_LIMIT);
  return { resolved, entries: versions };
}

/**
 * Parse a `CHANGELOG.md` blob into top-level heading entries.
 * Accepts headings in three shapes:
 *   - `## 1.2.3 — 2024-01-15`
 *   - `## [1.2.3] - 2024-01-15`
 *   - `## 1.2.3 (2024-01-15)`
 * and falls back to a heading-as-version when no semver is found.
 *
 * H1 (`#`) headings are treated as the file's title and are skipped —
 * release entries conventionally start at H2.
 */
export function entriesFromChangelogMd(markdown: string, limit: number = ENTRY_LIMIT): ChangelogMdEntry[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const entries: ChangelogMdEntry[] = [];
  let current: ChangelogMdEntry | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current) {
      current.summary = buffer.join(' ').replace(/\s+/g, ' ').trim();
      if (current.summary || current.version) entries.push(current);
    }
    current = null;
    buffer = [];
  };

  // Heading: ## 1.2.3 — 2024-01-15, ## [1.2.3] - 2024-01-15, ## 1.2.3 (2024-01-15)
  // Match H2 and H3 only (H1 is conventionally the file's title).
  const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;
  const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
  const SEMVER_RE = /v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const heading = m[2].trim();
      const dateMatch = DATE_RE.exec(heading);
      const semverMatch = SEMVER_RE.exec(heading);
      current = {
        version: semverMatch ? semverMatch[1] : heading,
        date: dateMatch ? dateMatch[1] : '',
        summary: '',
      };
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return entries.slice(0, limit);
}

/**
 * Merge registry entries (version + date) with CHANGELOG.md entries
 * (version + date + summary) by version. The registry's dates win
 * when both sides have one, since they're authoritative.
 */
export function mergeSummaries(
  registryEntries: ChangelogEntry[],
  mdEntries: ChangelogMdEntry[],
): ChangelogEntry[] {
  const byVersion = new Map<string, ChangelogMdEntry>();
  for (const e of mdEntries) byVersion.set(e.version, e);
  return registryEntries.map((r) => {
    const m = byVersion.get(r.version);
    if (!m) return r;
    return {
      version: r.version,
      date: r.date || m.date,
      summary: m.summary || r.summary,
    };
  });
}
