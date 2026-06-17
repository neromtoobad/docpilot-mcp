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

/** Curated, version-agnostic docs URLs for widely-used packages. */
const KNOWN_DOCS: Record<string, DocsSite> = {
  // npm — frontend / fullstack
  'npm:stripe': { url: 'https://docs.stripe.com/api', ecosystem: 'npm' },
  'npm:next': { url: 'https://nextjs.org/docs', ecosystem: 'npm' },
  'npm:react': { url: 'https://react.dev/reference/react', ecosystem: 'npm' },
  'npm:react-dom': { url: 'https://react.dev/reference/react-dom', ecosystem: 'npm' },
  'npm:vue': { url: 'https://vuejs.org/guide/introduction.html', ecosystem: 'npm' },
  'npm:nuxt': { url: 'https://nuxt.com/docs', ecosystem: 'npm' },
  'npm:svelte': { url: 'https://svelte.dev/docs', ecosystem: 'npm' },
  'npm:express': { url: 'https://expressjs.com/en/api.html', ecosystem: 'npm' },
  'npm:fastify': { url: 'https://fastify.dev/docs/latest/', ecosystem: 'npm' },
  'npm:axios': { url: 'https://axios-http.com/docs/intro', ecosystem: 'npm' },
  'npm:zod': { url: 'https://zod.dev/', ecosystem: 'npm' },
  'npm:typescript': { url: 'https://www.typescriptlang.org/docs/', ecosystem: 'npm' },
  'npm:prisma': { url: 'https://www.prisma.io/docs', ecosystem: 'npm' },
  'npm:drizzle-orm': { url: 'https://orm.drizzle.team/docs/overview', ecosystem: 'npm' },
  'npm:tailwindcss': { url: 'https://tailwindcss.com/docs', ecosystem: 'npm' },
  'npm:vite': { url: 'https://vitejs.dev/guide/', ecosystem: 'npm' },
  'npm:vitest': { url: 'https://vitest.dev/guide/', ecosystem: 'npm' },
  'npm:playwright': { url: 'https://playwright.dev/docs/intro', ecosystem: 'npm' },
  'npm:graphql': { url: 'https://graphql.org/learn/', ecosystem: 'npm' },
  'npm:openai': { url: 'https://platform.openai.com/docs/api-reference', ecosystem: 'npm' },
  // PyPI — data / web / ML
  'pypi:requests': { url: 'https://requests.readthedocs.io/en/latest/', ecosystem: 'pypi' },
  'pypi:flask': { url: 'https://flask.palletsprojects.com/', ecosystem: 'pypi' },
  'pypi:django': { url: 'https://docs.djangoproject.com/en/stable/', ecosystem: 'pypi' },
  'pypi:fastapi': { url: 'https://fastapi.tiangolo.com/', ecosystem: 'pypi' },
  'pypi:pandas': { url: 'https://pandas.pydata.org/docs/', ecosystem: 'pypi' },
  'pypi:numpy': { url: 'https://numpy.org/doc/stable/', ecosystem: 'pypi' },
  'pypi:sqlalchemy': { url: 'https://docs.sqlalchemy.org/en/20/', ecosystem: 'pypi' },
  'pypi:pydantic': { url: 'https://docs.pydantic.dev/latest/', ecosystem: 'pypi' },
  'pypi:httpx': { url: 'https://www.python-httpx.org/', ecosystem: 'pypi' },
  'pypi:pytest': { url: 'https://docs.pytest.org/en/stable/', ecosystem: 'pypi' },
  'pypi:openai': { url: 'https://platform.openai.com/docs/api-reference', ecosystem: 'pypi' },
  'pypi:anthropic': { url: 'https://docs.anthropic.com/en/api/getting-started', ecosystem: 'pypi' },
};

export function getKnownDocs(ecosystem: Ecosystem, pkg: string): DocsSite | null {
  return KNOWN_DOCS[`${ecosystem}:${pkg.toLowerCase()}`] ?? null;
}

export function listKnownPackages(): string[] {
  return Object.keys(KNOWN_DOCS);
}
