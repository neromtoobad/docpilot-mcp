/**
 * PyPI JSON API client.
 *
 * The PyPI JSON API is at https://pypi.org/pypi/<package>/json and
 * returns the canonical package metadata plus a `releases` map
 * keyed by version. Each value is an array of file descriptors with
 * `upload_time` stamps we can use to date each release.
 */
import { FetchHttpClient, type HttpClient } from '../../net/httpClient.js';

export interface PypiReleaseFile {
  filename: string;
  upload_time: string;
  size?: number;
  python_version?: string;
  /** Direct download URL for the file. Used by AC-6 to grab the wheel. */
  url?: string;
}

export interface PypiPackageInfo {
  info: {
    name: string;
    version: string;
    summary?: string;
    description?: string;
    home_page?: string;
    project_urls?: Record<string, string>;
    project_url?: string;
  };
  /** version → list of file descriptors uploaded for that release */
  releases: Record<string, PypiReleaseFile[]>;
  urls?: PypiReleaseFile[];
}

const PYPI_BASE = 'https://pypi.org/pypi';

/** Fetch a package's full PyPI JSON document. Throws HttpError(404) when missing. */
export async function fetchPypiPackage(
  http: HttpClient,
  name: string,
): Promise<PypiPackageInfo> {
  const url = `${PYPI_BASE}/${encodeURIComponent(name)}/json`;
  return await http.getJson<PypiPackageInfo>(url);
}

/** Convenience: a default PyPI client bound to the production JSON API. */
export const defaultPypiClient: HttpClient = new FetchHttpClient();
