/**
 * `search_examples` — return real code examples from the package's
 * official GitHub repository.
 *
 * Per AC-5, the source is restricted to:
 *   - the repo's `examples/` (or `example/`, `demo/`, `demos/`,
 *     `samples/`, `sample/`) directory, and
 *   - fenced code blocks in the repo's `README.md`.
 *
 * We do NOT call Stack Overflow, blogs, or third-party aggregators.
 *
 * Output shape (per AC-5):
 *   {
 *     package: string,
 *     ecosystem: 'npm' | 'pypi',
 *     version: string,
 *     query: string,
 *     examples: Array<{
 *       code: string, path: string, url: string, language: string
 *     }>
 *   }
 *
 * The handler validates the syntax of every returned `code` block
 * (`node --check` for JS, the TypeScript compiler's parser for TS,
 * and `python3 -c "import ast; ast.parse(...)"` for Python). The
 * output is capped at 10 snippets.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toolError, type ToolErrorCode } from '../util/errors.js';
import { debug, info, warn } from '../util/log.js';
import { FetchHttpClient, HttpError, type HttpClient } from '../net/httpClient.js';
import type { Ecosystem } from '../cache/paths.js';
import {
  fetchNpmPackage,
  type NpmPackageInfo,
} from '../sources/registry/npm.js';
import {
  fetchPypiPackage,
  type PypiPackageInfo,
} from '../sources/registry/pypi.js';
import {
  parseGitHubUrl,
  fetchRawFile,
  fetchRepoTree,
  blobUrl,
  blobUrlWithLines,
  README_FILENAMES,
  type GitHubRepo,
  type GitHubTreeResponse,
} from '../sources/github.js';
import {
  extractFencedCode,
  findExampleFiles,
  findReadmeInTree,
  rankSnippets,
  snippetFromFile,
  snippetFromReadme,
  type ExampleSnippet,
} from '../sources/examples.js';
import { detectLanguage, isValidSyntax } from '../util/syntaxValidate.js';

/** Public output contract for `search_examples` (matches AC-5 exactly). */
export interface SearchExamplesResult {
  package: string;
  ecosystem: Ecosystem;
  version: string;
  query: string;
  examples: Array<{
    code: string;
    path: string;
    url: string;
    language: string;
  }>;
}

export interface SearchExamplesDeps {
  http: HttpClient;
  /** Override the npm registry probe. */
  tryNpm?: (pkg: string) => Promise<NpmPackageInfo | null>;
  /** Override the PyPI registry probe. */
  tryPypi?: (pkg: string) => Promise<PypiPackageInfo | null>;
  /** Override the GitHub tree fetch. */
  fetchTree?: (repo: GitHubRepo) => Promise<GitHubTreeResponse | null>;
  /** Override the raw-file fetch (used for example files + README). */
  fetchFile?: (repo: GitHubRepo, path: string) => Promise<string | null>;
}

export interface SearchExamplesArgs {
  package: string;
  version: string;
  query: string;
  /** Optional explicit ecosystem hint. */
  ecosystem?: Ecosystem;
}

const MAX_RESULTS = 10;

/** Maximum number of example files we'll fetch per call. */
const MAX_EXAMPLE_FILES = 30;

function defaultTryNpm(
  http: HttpClient,
): (pkg: string) => Promise<NpmPackageInfo | null> {
  return async (pkg) => {
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
  return async (pkg) => {
    try {
      return await fetchPypiPackage(http, pkg);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  };
}

function defaultFetchTree(
  http: HttpClient,
): (repo: GitHubRepo) => Promise<GitHubTreeResponse | null> {
  return async (repo) => fetchRepoTree(http, repo);
}

function defaultFetchFile(
  http: HttpClient,
): (repo: GitHubRepo, path: string) => Promise<string | null> {
  return async (repo, path) => fetchRawFile(http, repo, path);
}

/** Resolve the package's GitHub repo from registry metadata. */
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
    parseGitHubUrl(urls.Homepage) ??
    parseGitHubUrl(pypi.info?.home_page) ??
    parseGitHubUrl(pypi.info?.project_url)
  );
}

/**
 * Try the README candidates in order; return the first hit's body.
 * Returns `null` when no README exists in the repo.
 */
async function fetchReadme(
  fetchFile: (repo: GitHubRepo, path: string) => Promise<string | null>,
  repo: GitHubRepo,
): Promise<{ path: string; body: string } | null> {
  for (const name of README_FILENAMES) {
    try {
      const body = await fetchFile(repo, name);
      if (body !== null) return { path: name, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`search_examples README fetch failed for ${name}: ${message}`);
    }
  }
  return null;
}

/**
 * Pure handler — exported so tests can call it directly with custom
 * `tryNpm` / `tryPypi` / `fetchTree` / `fetchFile` implementations.
 */
export async function handleSearchExamples(
  args: SearchExamplesArgs,
  userDeps: Partial<SearchExamplesDeps> = {},
): Promise<
  | { ok: true; result: SearchExamplesResult }
  | { ok: false; code: ToolErrorCode; message: string }
> {
  if (args.query.trim().length < 2) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: `query is too short (${args.query.trim().length} chars); need at least 2`,
    };
  }

  const http = userDeps.http ?? new FetchHttpClient();
  const tryNpm = userDeps.tryNpm ?? defaultTryNpm(http);
  const tryPypi = userDeps.tryPypi ?? defaultTryPypi(http);
  const fetchTree = userDeps.fetchTree ?? defaultFetchTree(http);
  const fetchFile = userDeps.fetchFile ?? defaultFetchFile(http);

  const pkg = args.package;
  const versionSpec = args.version;
  const ecosystemHint = args.ecosystem;

  // 1) Resolve the ecosystem (try the hinted one first; otherwise
  //    try npm → fall back to PyPI on 404).
  let ecosystem: Ecosystem;
  let registryInfo: NpmPackageInfo | PypiPackageInfo;
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
  } else {
    const npm = await tryNpm(pkg);
    if (npm) {
      ecosystem = 'npm';
      registryInfo = npm;
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
    }
  }

  // 2) Resolve the GitHub repo from the registry metadata.
  const repo = extractRepo(ecosystem, registryInfo);
  if (!repo) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `Could not determine a GitHub repo for ${ecosystem} package "${pkg}" from registry metadata.`,
    };
  }

  // 3) Fetch the repo tree.
  let tree: GitHubTreeResponse | null;
  try {
    tree = await fetchTree(repo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'E_UPSTREAM',
      message: `Failed to fetch repo tree for ${repo.owner}/${repo.repo}: ${message}`,
    };
  }
  if (!tree) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `No tree found for ${repo.owner}/${repo.repo} (branches ${repo.branch}, master both 404).`,
    };
  }

  // 4) Collect candidate example files (capped so we don't try to
  //    fetch every single file in a 5k-example repo).
  const exampleFiles = findExampleFiles(tree.tree, MAX_EXAMPLE_FILES);
  const readmeEntry = findReadmeInTree(tree.tree);

  info(
    `search_examples ecosystem=${ecosystem} pkg=${pkg}@${versionSpec} repo=${repo.owner}/${repo.repo} exampleFiles=${exampleFiles.length} readme=${readmeEntry?.path ?? 'none'}`,
  );

  // 5) Fetch example files (sequentially — we cap at MAX_EXAMPLE_FILES
  //    and most repos have fewer than that).
  const snippets: ExampleSnippet[] = [];
  const fetchFailures: string[] = [];
  for (const item of exampleFiles) {
    let body: string | null;
    try {
      body = await fetchFile(repo, item.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`search_examples failed to fetch ${item.path}: ${message}`);
      fetchFailures.push(item.path);
      continue;
    }
    if (body === null) {
      fetchFailures.push(item.path);
      continue;
    }
    snippets.push(
      snippetFromFile(
        repo,
        item,
        body,
        (r, p) => blobUrl(r, p),
        (filename) => detectLanguage(null, filename),
      ),
    );
  }
  if (fetchFailures.length > 0) {
    debug(
      `search_examples ${fetchFailures.length} example file(s) failed to fetch: ${fetchFailures.slice(0, 3).join(', ')}${fetchFailures.length > 3 ? '…' : ''}`,
    );
  }

  // 6) Fetch the README and extract fenced code blocks.
  if (readmeEntry) {
    const readme = await fetchReadme(fetchFile, repo);
    if (readme) {
      const blocks = extractFencedCode(readme.body);
      for (const block of blocks) {
        snippets.push(
          snippetFromReadme(
            repo,
            readme.path,
            block,
            (r, p, s, e) => blobUrlWithLines(r, p, s, e),
            (info, filename) => detectLanguage(info, filename),
          ),
        );
      }
    }
  }

  // 7) Rank and trim.
  const ranked = rankSnippets(snippets, args.query, { topK: MAX_RESULTS });
  if (ranked.length === 0) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `No code examples found in ${repo.owner}/${repo.repo} matching "${args.query}".`,
    };
  }

  // 8) Validate syntax; drop snippets whose code doesn't parse
  //    (the AC requires valid syntax in the output).
  const valid = ranked.filter((s) => {
    const ok = isValidSyntax(s.code, s.language as never, s.path);
    if (!ok) {
      warn(`search_examples dropping invalid ${s.language} snippet at ${s.path}:L${s.startLine}`);
    }
    return ok;
  });

  return {
    ok: true,
    result: {
      package: pkg,
      ecosystem,
      version: versionSpec,
      query: args.query,
      examples: valid.map((s) => ({
        code: s.code,
        path: s.path,
        url: s.url,
        language: s.language,
      })),
    },
  };
}

export function registerSearchExamples(server: McpServer): void {
  server.registerTool(
    'search_examples',
    {
      title: 'Search official code examples',
      description:
        'Return up to 10 real code examples from the package\'s official GitHub repo, limited to the examples/ directory and README.md.',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "stripe" or "requests".'),
        version: z
          .string()
          .min(1)
          .describe('Exact semver or "latest" (default behaviour for the package ecosystem).'),
        query: z
          .string()
          .min(2)
          .describe('Free-text query, e.g. "create a customer with a payment method".'),
        ecosystem: z
          .enum(['npm', 'pypi'])
          .optional()
          .describe(
            'Optional explicit ecosystem hint. When omitted, the handler tries npm first and falls back to PyPI on 404.',
          ),
      },
    },
    async (args) => {
      const out = await handleSearchExamples(args);
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
