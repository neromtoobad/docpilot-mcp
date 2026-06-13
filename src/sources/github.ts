/**
 * Minimal GitHub raw-file + tree helpers.
 *
 * We only need to:
 *   (a) parse a `git+https://github.com/o/r.git` repository URL into
 *       `{owner, repo, branch}`,
 *   (b) fetch a single raw file (e.g. `CHANGELOG.md`, `README.md`,
 *       `examples/foo.js`) from that repo's default branch, falling
 *       back to `master` when `main` 404s, and
 *   (c) walk the repo's full file tree via the Git Trees API so we
 *       can locate the `examples/` directory without scraping the
 *       GitHub HTML.
 *
 * The full `octokit` SDK is overkill for v0.1; we hit
 * https://raw.githubusercontent.com and https://api.github.com
 * directly.
 */
import {
  FetchHttpClient,
  HttpError,
  type HttpClient,
} from '../net/httpClient.js';
import { info, warn } from '../util/log.js';

export interface GitHubRepo {
  owner: string;
  repo: string;
  branch: string;
}

const RAW_BASE = 'https://raw.githubusercontent.com';
const API_BASE = 'https://api.github.com';

const GITHUB_URL_RE =
  /github\.com[/:]+([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[\/#].*)?$/i;

/**
 * Parse a GitHub repository URL into `{owner, repo, branch}`. Returns
 * `null` if the URL doesn't look like a GitHub repo URL.
 */
export function parseGitHubUrl(url: string | undefined | null): GitHubRepo | null {
  if (!url) return null;
  const m = GITHUB_URL_RE.exec(url.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: 'main' };
}

/**
 * Try common default branches (`main`, then `master`) and return the
 * raw file contents. Returns `null` if every branch 404s.
 */
export async function fetchRawFile(
  http: HttpClient,
  repo: GitHubRepo,
  path: string,
): Promise<string | null> {
  for (const branch of [repo.branch, 'master']) {
    const url = `${RAW_BASE}/${repo.owner}/${repo.repo}/${branch}/${path}`;
    try {
      return await http.get(url);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
        continue;
      }
      throw err;
    }
  }
  return null;
}

/** A single entry in the GitHub Trees API response. */
export interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
}

/** Shape we need from `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1`. */
export interface GitHubTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

export interface GitHubTreeFetchOptions {
  /**
   * Set to `true` to also fall back to `master` when the configured
   * branch 404s. Defaults to `true`.
   */
  fallbackToMaster?: boolean;
}

/**
 * Fetch the full recursive tree for `repo` via the Git Trees API.
 * Returns `null` if every branch 404s.
 *
 * The endpoint caps recursive trees at 100k entries and may set
 * `truncated: true` for very large repos. Callers that care should
 * inspect the `truncated` field on the response.
 */
export async function fetchRepoTree(
  http: HttpClient,
  repo: GitHubRepo,
  options: GitHubTreeFetchOptions = {},
): Promise<GitHubTreeResponse | null> {
  const fallback = options.fallbackToMaster ?? true;
  const branches = fallback ? [repo.branch, 'master'] : [repo.branch];
  let lastError: unknown = null;
  for (const branch of branches) {
    const url = `${API_BASE}/repos/${repo.owner}/${repo.repo}/git/trees/${branch}?recursive=1`;
    try {
      const data = await http.getJson<GitHubTreeResponse>(url);
      if (data.truncated) {
        warn(
          `fetchRepoTree ${repo.owner}/${repo.repo}@${branch} returned truncated=true (very large repo); examples/ filtering may be incomplete`,
        );
      }
      return data;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  info(
    `fetchRepoTree ${repo.owner}/${repo.repo}: no tree found for branches ${branches.join(', ')} (${(lastError as Error | null)?.message ?? 'no error'})`,
  );
  return null;
}

/** Convenience: a default client bound to raw.githubusercontent.com. */
export const defaultGitHubClient: HttpClient = new FetchHttpClient();

/** Default candidate filenames for the README, in priority order. */
export const README_FILENAMES = [
  'README.md',
  'README.rst',
  'README.txt',
  'README',
  'readme.md',
  'Readme.md',
] as const;

/** Build a `https://github.com/{o}/{r}/blob/{branch}/{path}` URL. */
export function blobUrl(repo: GitHubRepo, path: string, branch?: string): string {
  const ref = branch ?? repo.branch;
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${ref}/${path}`;
}

/** Build a `https://github.com/{o}/{r}/blob/{branch}/{path}#L{n}-L{m}` URL. */
export function blobUrlWithLines(
  repo: GitHubRepo,
  path: string,
  startLine: number,
  endLine: number,
  branch?: string,
): string {
  return `${blobUrl(repo, path, branch)}#L${startLine}-L${endLine}`;
}
