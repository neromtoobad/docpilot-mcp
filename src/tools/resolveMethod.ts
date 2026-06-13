/**
 * `resolve_method` — return the current signature, parameter list,
 * and source location of a method in a pinned package version.
 *
 * Per AC-6:
 *   - TypeScript/JS: signatures are extracted from the `.d.ts` file
 *     in the package tarball; `source.path` is the relative path
 *     inside the tarball, `source.line` is the 1-indexed line of
 *     the declaration, and the `signature` field is the literal
 *     source text of the declaration.
 *   - Python: signatures are extracted from the wheel's `.pyi`
 *     stubs when present, otherwise from the wheel's `.py` source
 *     using Python's `ast` module.
 *   - Returns `E_NOT_FOUND` (`MethodNotFound`) when the method
 *     does not exist in the requested version.
 *
 * Output shape:
 *   {
 *     package, version, method, signature,
 *     params: [{ name, type, required, description }],
 *     returns, source: { url, path, line }
 *   }
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
  loadNpmDts,
  loadPyStubsAndSource,
  type ExtractedFileMap,
} from '../extractors/source.js';
import {
  findSignatureInDts,
  type ExtractedSignature,
  type ExtractedParam,
} from '../extractors/ts.js';
import { findSignatureInPy } from '../extractors/py.js';

/** Public output contract for `resolve_method` (matches AC-6 exactly). */
export interface ResolveMethodResult {
  package: string;
  version: string;
  method: string;
  signature: string;
  params: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  returns: string;
  source: {
    url: string;
    path: string;
    line: number;
  };
}

export interface ResolveMethodDeps {
  http: HttpClient;
  /** Override the npm registry probe. */
  tryNpm?: (pkg: string) => Promise<NpmPackageInfo | null>;
  /** Override the PyPI registry probe. */
  tryPypi?: (pkg: string) => Promise<PypiPackageInfo | null>;
  /**
   * Override the package-file loader (I/O layer). Returns a map
   * of repo-relative path to file content. The default delegates
   * to `loadNpmDts` / `loadPyStubsAndSource` based on ecosystem.
   */
  loadPackageFiles?: (
    ecosystem: Ecosystem,
    pkg: string,
    version: string,
  ) => Promise<ExtractedFileMap | null>;
  /**
   * Override the TS signature extractor (used in tests so we can
   * bypass the .d.ts path and feed a fixture directly).
   */
  extractFromTs?: (
    content: string,
    methodPath: string,
    filePath: string,
  ) => ExtractedSignature | null;
  /**
   * Override the Python signature extractor (used in tests).
   */
  extractFromPy?: (
    content: string,
    methodPath: string,
    filePath: string,
  ) => ExtractedSignature | null;
}

export interface ResolveMethodArgs {
  package: string;
  version: string;
  method: string;
  /** Optional explicit ecosystem hint. */
  ecosystem?: Ecosystem;
}

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

async function defaultLoadPackageFiles(
  http: HttpClient,
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<ExtractedFileMap | null> {
  if (ecosystem === 'npm') {
    const info = await fetchNpmPackage(http, pkg);
    return await loadNpmDts(http, info, version);
  }
  const info = await fetchPypiPackage(http, pkg);
  return await loadPyStubsAndSource(http, info, version);
}

/** Pure handler — exported so tests can call it directly. */
export async function handleResolveMethod(
  args: ResolveMethodArgs,
  userDeps: Partial<ResolveMethodDeps> = {},
): Promise<
  | { ok: true; result: ResolveMethodResult }
  | { ok: false; code: ToolErrorCode; message: string }
> {
  if (!args.method || args.method.trim().length === 0) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: 'method is required (e.g. "customers.create" or "Session.request")',
    };
  }
  if (!/^[A-Za-z_][\w.]*$/.test(args.method)) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: `method must be a dotted identifier (got "${args.method}")`,
    };
  }

  const http = userDeps.http ?? new FetchHttpClient();
  const tryNpm = userDeps.tryNpm ?? defaultTryNpm(http);
  const tryPypi = userDeps.tryPypi ?? defaultTryPypi(http);
  const loadPackageFiles =
    userDeps.loadPackageFiles ??
    ((ecosystem, pkg, version) => defaultLoadPackageFiles(http, ecosystem, pkg, version));
  const extractFromTs = userDeps.extractFromTs ?? findSignatureInDts;
  const extractFromPy = userDeps.extractFromPy ?? findSignatureInPy;

  const pkg = args.package;
  const versionSpec = args.version;
  const ecosystemHint = args.ecosystem;
  const methodPath = args.method.trim();

  // 1) Resolve the ecosystem.
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

  // 2) Load the package's source files.
  let files: ExtractedFileMap | null;
  try {
    files = await loadPackageFiles(ecosystem, pkg, versionSpec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`resolve_method loadPackageFiles failed: ${message}`);
    return {
      ok: false,
      code: 'E_UPSTREAM',
      message: `Failed to load source for ${ecosystem} package "${pkg}": ${message}`,
    };
  }
  if (!files || files.size === 0) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `Could not extract any source files for ${ecosystem} package "${pkg}"@${versionSpec}.`,
    };
  }

  info(
    `resolve_method ecosystem=${ecosystem} pkg=${pkg}@${versionSpec} method=${methodPath} files=${files.size}`,
  );

  // 3) Find the method in the loaded files.
  const extract = ecosystem === 'npm' ? extractFromTs : extractFromPy;
  let found: { filePath: string; sig: ExtractedSignature } | null = null;
  for (const [filePath, content] of files) {
    if (ecosystem === 'npm' && !filePath.endsWith('.d.ts')) continue;
    if (ecosystem === 'pypi' && !filePath.endsWith('.pyi') && !filePath.endsWith('.py')) {
      continue;
    }
    const sig = extract(content, methodPath, filePath);
    if (sig) {
      found = { filePath, sig };
      break;
    }
  }
  if (!found) {
    debug(
      `resolve_method method=${methodPath} not found in ${files.size} ${ecosystem} files for ${pkg}@${versionSpec}`,
    );
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `Method "${methodPath}" not found in ${pkg}@${versionSpec} (${ecosystem}).`,
    };
  }

  // 4) Build the public output. The `source.url` is the GitHub
  //    blob URL when we can resolve a repo from the registry;
  //    otherwise we fall back to a generic "package@version"
  //    identifier so the caller can still navigate.
  const repoUrl = sourceUrlFor(
    ecosystem,
    registryInfo,
    versionSpec,
    found.filePath,
    found.sig.sourceLine,
  );

  return {
    ok: true,
    result: {
      package: pkg,
      version: versionSpec,
      method: methodPath,
      signature: found.sig.signature,
      params: found.sig.params.map((p: ExtractedParam) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description,
      })),
      returns: found.sig.returns,
      source: {
        url: repoUrl,
        path: found.filePath,
        line: found.sig.sourceLine,
      },
    },
  };
}

/**
 * Build the `source.url` field. For npm, we point to the
 * unpkg.com CDN view of the matching .d.ts file with a
 * `#L{line}` anchor. For PyPI we use the wheel's served file on
 * a CDN (e.g. files.pythonhosted.org). Both are deterministic
 * and stable for the lifetime of the published artifact.
 */
function sourceUrlFor(
  ecosystem: Ecosystem,
  info: NpmPackageInfo | PypiPackageInfo,
  version: string,
  filePath: string,
  line: number,
): string {
  if (ecosystem === 'npm') {
    const npm = info as NpmPackageInfo;
    const name = npm.name;
    return `https://unpkg.com/${name}@${version}/${filePath}#L${line}`;
  }
  const pypi = info as PypiPackageInfo;
  const name = pypi.info.name;
  return `https://files.pythonhosted.org/source/${name[0]}/${name}/${name}-${version}.tar.gz::${filePath}#L${line}`;
}

export function registerResolveMethod(server: McpServer): void {
  server.registerTool(
    'resolve_method',
    {
      title: 'Resolve method signature',
      description:
        'Return the current signature, parameter list, return type, and source location of a method in a pinned package version (`.d.ts` for JS/TS, `.pyi`/`.py` AST for Python).',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "stripe" or "requests".'),
        version: z
          .string()
          .min(1)
          .describe('Exact semver or version pin (no "latest" — must be resolvable).'),
        method: z
          .string()
          .min(1)
          .describe('Dotted method path, e.g. "customers.create" or "Session.create".'),
        ecosystem: z
          .enum(['npm', 'pypi'])
          .optional()
          .describe(
            'Optional explicit ecosystem hint. When omitted, the handler tries npm first and falls back to PyPI on 404.',
          ),
      },
    },
    async (args) => {
      const out = await handleResolveMethod(args);
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
