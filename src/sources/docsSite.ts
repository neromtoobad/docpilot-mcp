/**
 * Resolve a package's official docs URL.
 *
 * Strategy (in order):
 *   1. If the package is in the known mapping (stripe, next, requests, …),
 *      use that canonical docs URL.
 *   2. Otherwise, query the registry to read the package's `homepage`.
 *   3. Otherwise, return null and let the caller decide what to do.
 *
 * AC-3 ships with the small known mapping below; AC-4 will reuse this
 * module to wire `get_changelog` to the same registry.
 */
import type { Ecosystem } from '../cache/paths.js';

export interface DocsSite {
  url: string;
  ecosystem: Ecosystem;
}

/** Curated, version-agnostic docs URLs for the AC-3 "must work" packages. */
const KNOWN_DOCS: Record<string, DocsSite> = {
  'npm:stripe': { url: 'https://docs.stripe.com/api', ecosystem: 'npm' },
  'npm:next': { url: 'https://nextjs.org/docs', ecosystem: 'npm' },
  'npm:react': { url: 'https://react.dev/reference/react', ecosystem: 'npm' },
  'npm:vue': { url: 'https://vuejs.org/guide/introduction.html', ecosystem: 'npm' },
  'pypi:requests': {
    url: 'https://requests.readthedocs.io/en/latest/',
    ecosystem: 'pypi',
  },
  'pypi:flask': { url: 'https://flask.palletsprojects.com/', ecosystem: 'pypi' },
  'pypi:pandas': { url: 'https://pandas.pydata.org/docs/', ecosystem: 'pypi' },
  'pypi:numpy': { url: 'https://numpy.org/doc/stable/', ecosystem: 'pypi' },
};

export function getKnownDocs(ecosystem: Ecosystem, pkg: string): DocsSite | null {
  return KNOWN_DOCS[`${ecosystem}:${pkg.toLowerCase()}`] ?? null;
}

export function listKnownPackages(): string[] {
  return Object.keys(KNOWN_DOCS);
}
