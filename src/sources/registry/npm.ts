/**
 * npm registry client.
 *
 * The npm registry's documented public endpoint is
 *   https://registry.npmjs.org/<package>
 * which returns a JSON blob describing the package, its versions,
 * its publish-time map, and its repository / homepage.
 */
import { FetchHttpClient, type HttpClient } from '../../net/httpClient.js';

export interface NpmRepositoryRef {
  type?: string;
  url?: string;
}

export interface NpmVersionInfo {
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  repository?: NpmRepositoryRef;
  /**
   * Distribution info published by the registry. The `tarball`
   * URL is what we download in AC-6 to extract the package's
   * `.d.ts` source.
   */
  dist?: {
    tarball?: string;
    shasum?: string;
    integrity?: string;
  };
}

export interface NpmPackageInfo {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, NpmVersionInfo>;
  homepage?: string;
  repository?: NpmRepositoryRef;
  description?: string;
  /** version → ISO-8601 publish time; also includes `created` and `modified` keys. */
  time?: Record<string, string>;
  maintainers?: Array<{ name: string; email?: string }>;
}

const REGISTRY_BASE = 'https://registry.npmjs.org';

/** Fetch a package's full registry document. Throws HttpError(404) when missing. */
export async function fetchNpmPackage(
  http: HttpClient,
  name: string,
): Promise<NpmPackageInfo> {
  const url = `${REGISTRY_BASE}/${encodeURIComponent(name)}`;
  return await http.getJson<NpmPackageInfo>(url);
}

/** Convenience: a default registry client bound to the production registry. */
export const defaultNpmClient: HttpClient = new FetchHttpClient();
