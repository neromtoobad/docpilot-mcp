/**
 * `get_changelog` — return the 10 most recent changelog entries for
 * an npm or PyPI package, with a transparent fallback to
 * `CHANGELOG.md` on the package's default GitHub branch.
 *
 * Output shape (per AC-4):
 *   {
 *     package: string,
 *     ecosystem: 'npm' | 'pypi',
 *     version: string,           // the resolved version (or "latest" if unknown)
 *     entries: Array<{ version: string, date: string, summary: string }>
 *   }
 *
 * Flow:
 *   1. Try npm registry; on 404, fall back to PyPI.
 *   2. Pull version+date from the registry.
 *   3. Pull summaries from CHANGELOG.md on the package's GitHub
 *      default branch (when the registry exposes a `repository` URL).
 *   4. Merge and return the 10 most recent.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toolError, type ToolErrorCode } from '../util/errors.js';
import { debug, info, warn } from '../util/log.js';
import { FetchHttpClient, HttpError, type HttpClient } from '../net/httpClient.js';
import type { Ecosystem } from '../cache/paths.js';
import { fetchNpmPackage, type NpmPackageInfo } from '../sources/registry/npm.js';
import { fetchPypiPackage, type PypiPackageInfo } from '../sources/registry/pypi.js';
import { parseGitHubUrl, fetchRawFile, type GitHubRepo } from '../sources/github.js';
import {
  entriesFromNpm,
  entriesFromPypi,
  entriesFromChangelogMd,
  mergeSummaries,
  type ChangelogEntry,
} from '../sources/changelog.js';

/** Public output contract for `get_changelog` (matches AC-4 exactly). */
export interface GetChangelogResult {
  package: string;
  ecosystem: Ecosystem;
  version: string;
  entries: ChangelogEntry[];
}

export interface GetChangelogDeps {
  http: HttpClient;
  /** Override: try the npm registry and return either an info doc or null on 404. */
  tryNpm?: (pkg: string) => Promise<NpmPackageInfo | null>;
  /** Override: try the PyPI registry and return either an info doc or null on 404. */
  tryPypi?: (pkg: string) => Promise<PypiPackageInfo | null>;
  /** Override: fetch a raw file from a GitHub repo (returns null on 404). */
  fetchChangelogMd?: (repo: GitHubRepo) => Promise<string | null>;
}

export interface GetChangelogArgs {
  package: string;
  version?: string;
  /**
   * Optional explicit ecosystem hint. When provided, the handler
   * queries that registry first instead of trying npm then falling
   * back to PyPI on 404. Useful when both ecosystems have a
   * package with the same name (e.g. `requests`).
   */
  ecosystem?: Ecosystem;
}

const DEFAULT_VERSION = 'latest';
const ENTRY_LIMIT = 10;

function defaultTryNpm(
  http: HttpClient,
): (pkg: string) => Promise<NpmPackageInfo | null> {
  return async (pkg: string) => {
    try {
      return await fetchNpmPackage(http, pkg);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };
}

function defaultTryPypi(
  http: HttpClient,
): (pkg: string) => Promise<PypiPackageInfo | null> {
  return async (pkg: string) => {
    try {
      return await fetchPypiPackage(http, pkg);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };
}

function defaultFetchChangelogMd(
  http: HttpClient,
): (repo: GitHubRepo) => Promise<string | null> {
  return async (repo: GitHubRepo) => fetchRawFile(http, repo, 'CHANGELOG.md');
}

/**
 * Locate the package's GitHub repo from the registry metadata.
 * npm: `repository.url`. PyPI: `info.project_urls.Source`,
 * `info.project_urls.Repository`, or `info.home_page`.
 */
function extractRepo(
  ecosystem: Ecosystem,
  info: NpmPackageInfo | PypiPackageInfo,
): GitHubRepo | null {
  if (ecosystem === 'npm') {
    const npm = info as NpmPackageInfo;
    return parseGitHubUrl(npm.repository?.url) ?? parseGitHubUrl(npm.homepage);
  }
  const pypi = info as PypiPackageInfo;
  const urls = pypi.info?.project_urls ?? {};
  return (
    parseGitHubUrl(urls.Source) ??
    parseGitHubUrl(urls.Repository) ??
    parseGitHubUrl(urls['Source Code']) ??
    parseGitHubUrl(pypi.info?.home_page) ??
    parseGitHubUrl(pypi.info?.project_url)
  );
}

/**
 * Pure handler — exported so tests can call it directly with custom
 * `tryNpm` / `tryPypi` / `fetchChangelogMd` implementations.
 */
export async function handleGetChangelog(
  args: GetChangelogArgs,
  userDeps: Partial<GetChangelogDeps> = {},
): Promise<
  | { ok: true; result: GetChangelogResult }
  | { ok: false; code: ToolErrorCode; message: string }
> {
  const http = userDeps.http ?? new FetchHttpClient();
  const tryNpm = userDeps.tryNpm ?? defaultTryNpm(http);
  const tryPypi = userDeps.tryPypi ?? defaultTryPypi(http);
  const fetchChangelogMd =
    userDeps.fetchChangelogMd ?? defaultFetchChangelogMd(http);

  const pkg = args.package;
  const versionSpec = args.version ?? DEFAULT_VERSION;
  const ecosystemHint = args.ecosystem;

  // 1) Resolve the ecosystem. When the caller passes an explicit
  // `ecosystem` hint, query that registry first; otherwise try npm
  // then fall back to PyPI on 404.
  let ecosystem: Ecosystem;
  let registryInfo: NpmPackageInfo | PypiPackageInfo;
  let registryEntries: ChangelogEntry[];
  let resolved: string;
  if (ecosystemHint === 'npm') {
    const npm = await tryNpm(pkg);
    if (!npm) {
      return {
        ok: false,
        code: 'E_NOT_FOUND',
        message: `Package "${pkg}" not found in npm registry.`,
      };
    }
    ecosystem = 'npm';
    registryInfo = npm;
    ({ entries: registryEntries, resolved } = entriesFromNpm(npm, versionSpec));
  } else if (ecosystemHint === 'pypi') {
    const pypi = await tryPypi(pkg);
    if (!pypi) {
      return {
        ok: false,
        code: 'E_NOT_FOUND',
        message: `Package "${pkg}" not found in PyPI registry.`,
      };
    }
    ecosystem = 'pypi';
    registryInfo = pypi;
    ({ entries: registryEntries, resolved } = entriesFromPypi(pypi, versionSpec));
  } else {
    // Auto-detect: try npm first, then PyPI on 404.
    const npm = await tryNpm(pkg);
    if (npm) {
      ecosystem = 'npm';
      registryInfo = npm;
      ({ entries: registryEntries, resolved } = entriesFromNpm(npm, versionSpec));
    } else {
      const pypi = await tryPypi(pkg);
      if (!pypi) {
        return {
          ok: false,
          code: 'E_NOT_FOUND',
          message: `Package "${pkg}" not found in npm or PyPI registries. Pass an explicit "ecosystem" hint to disambiguate.`,
        };
      }
      ecosystem = 'pypi';
      registryInfo = pypi;
      ({ entries: registryEntries, resolved } = entriesFromPypi(pypi, versionSpec));
    }
  }

  info(
    `get_changelog ecosystem=${ecosystem} pkg=${pkg}@${versionSpec} resolved=${resolved} entries=${registryEntries.length}`,
  );

  // 2) GitHub CHANGELOG.md fallback for summaries.
  let entries = registryEntries;
  const repo = extractRepo(ecosystem, registryInfo);
  if (repo) {
    debug(`get_changelog fetching CHANGELOG.md from ${repo.owner}/${repo.repo}`);
    let md: string | null = null;
    try {
      md = await fetchChangelogMd(repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`get_changelog CHANGELOG.md fetch failed: ${message}`);
    }
    if (md) {
      // Parse the whole CHANGELOG.md (no limit) so the merge has
      // every version available. The final `slice(0, ENTRY_LIMIT)`
      // below enforces the 10-entry cap on the output.
      const mdEntries = entriesFromChangelogMd(md, Number.POSITIVE_INFINITY);
      if (mdEntries.length > 0) {
        entries = mergeSummaries(registryEntries, mdEntries);
      }
    }
  }

  return {
    ok: true,
    result: {
      package: pkg,
      ecosystem,
      version: resolved,
      entries: entries.slice(0, ENTRY_LIMIT),
    },
  };
}

export function registerGetChangelog(server: McpServer): void {
  server.registerTool(
    'get_changelog',
    {
      title: 'Get recent changelog entries',
      description:
        'Return the 10 most recent changelog entries for an npm or PyPI package, with a transparent fallback to CHANGELOG.md on the package\'s default GitHub branch.',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "stripe" or "requests".'),
        version: z
          .string()
          .min(1)
          .optional()
          .describe('Optional version pin. Defaults to "latest" when omitted.'),
        ecosystem: z
          .enum(['npm', 'pypi'])
          .optional()
          .describe(
            'Optional explicit ecosystem hint. When omitted, the handler tries npm first and falls back to PyPI on 404. Pass "pypi" to skip the npm probe when both ecosystems publish a package with the same name (e.g. "requests").',
          ),
      },
    },
    async (args) => {
      const out = await handleGetChangelog(args);
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
