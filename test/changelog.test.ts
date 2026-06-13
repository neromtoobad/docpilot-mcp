/**
 * AC-4 — `get_changelog` returns the latest changelog entries for a
 * package, on both npm and PyPI ecosystems, with a transparent
 * fallback to CHANGELOG.md on GitHub when the registry doesn't carry
 * per-release summaries.
 *
 * Per the plan's verification matrix:
 *   "Tests pass for npm + PyPI fixtures; live run against `stripe`
 *    returns ≥1 entry."
 *
 * We exercise the documented output contract offline against the
 * recorded fixtures under `test/fixtures/registry/`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  handleGetChangelog,
  type GetChangelogDeps,
} from '../src/tools/getChangelog.js';
import type { NpmPackageInfo } from '../src/sources/registry/npm.js';
import type { PypiPackageInfo } from '../src/sources/registry/pypi.js';
import type { GitHubRepo } from '../src/sources/github.js';
import {
  entriesFromNpm,
  entriesFromPypi,
  entriesFromChangelogMd,
  mergeSummaries,
  npmTimeMap,
  pypiTimeMap,
} from '../src/sources/changelog.js';
import { parseGitHubUrl } from '../src/sources/github.js';

import npmStripeFixture from './fixtures/registry/npm-stripe.json' with { type: 'json' };
import pypiRequestsFixture from './fixtures/registry/pypi-requests.json' with { type: 'json' };

// Markdown files: read via fs so we don't need the import-attributes
// `with { type: 'text' }` syntax (which Vite/Rollup doesn't accept
// for arbitrary extensions in v2.x).
const HERE = dirname(fileURLToPath(import.meta.url));
const stripeChangelogMd = readFileSync(
  join(HERE, 'fixtures/registry/stripe-changelog.md'),
  'utf8',
);
const requestsChangelogMd = readFileSync(
  join(HERE, 'fixtures/registry/requests-changelog.md'),
  'utf8',
);

const npmStripe = npmStripeFixture as unknown as NpmPackageInfo;
const pypiRequests = pypiRequestsFixture as unknown as PypiPackageInfo;

function makeDeps(overrides: Partial<GetChangelogDeps> = {}): GetChangelogDeps {
  return {
    http: {
      get: async () => '',
      getJson: async () => ({}),
    },
    tryNpm: async (pkg) => {
      if (pkg === 'stripe') return npmStripe;
      if (pkg === 'requests') return null; // simulate npm 404
      return null;
    },
    tryPypi: async (pkg) => {
      if (pkg === 'requests') return pypiRequests;
      if (pkg === 'stripe') return null; // simulate PyPI 404
      return null;
    },
    fetchChangelogMd: async (repo: GitHubRepo) => {
      if (repo.owner === 'stripe' && repo.repo === 'stripe-node') return stripeChangelogMd;
      if (repo.owner === 'psf' && repo.repo === 'requests') return requestsChangelogMd;
      return null;
    },
    ...overrides,
  };
}

describe('AC-4: get_changelog — version-accurate entries for npm and PyPI', () => {
  it('npm: returns the documented output shape with at most 10 newest entries, summaries from CHANGELOG.md', async () => {
    const out = await handleGetChangelog({ package: 'stripe', version: '5.0.0' }, makeDeps());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const { result } = out;
    expect(result.package).toBe('stripe');
    expect(result.ecosystem).toBe('npm');
    expect(result.version).toBe('5.0.0');
    expect(result.entries.length).toBeLessThanOrEqual(10);
    expect(result.entries.length).toBeGreaterThan(0);

    // Newest first.
    for (let i = 1; i < result.entries.length; i++) {
      expect(
        result.entries[i - 1].date.localeCompare(result.entries[i].date),
        `entry ${i - 1} should be newer than entry ${i}`,
      ).toBeGreaterThanOrEqual(0);
    }

    // The registry gave us a description that's the same for every
    // version (it's the package description, not a per-release
    // summary). The GitHub CHANGELOG.md fallback should have
    // overwritten the summary for 5.0.0 with a real, longer
    // sentence — that's the whole point of AC-4's fallback rule.
    const e500 = result.entries.find((e) => e.version === '5.0.0');
    expect(e500).toBeDefined();
    expect(e500!.summary).toMatch(/auto_pagination_iter/);

    // Each entry has the documented shape.
    for (const entry of result.entries) {
      expect(typeof entry.version).toBe('string');
      expect(typeof entry.date).toBe('string');
      expect(typeof entry.summary).toBe('string');
    }
  });

  it('pypi: returns the documented output shape with at most 10 newest entries, summaries from CHANGELOG.md', async () => {
    const out = await handleGetChangelog({ package: 'requests' }, makeDeps());
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const { result } = out;
    expect(result.package).toBe('requests');
    expect(result.ecosystem).toBe('pypi');
    expect(result.version).toBe('2.32.3'); // resolved from info.version when "latest"
    expect(result.entries.length).toBeLessThanOrEqual(10);
    expect(result.entries.length).toBeGreaterThan(0);

    // The GitHub CHANGELOG.md should have provided a real summary
    // for at least one release.
    const e2323 = result.entries.find((e) => e.version === '2.32.3');
    expect(e2323).toBeDefined();
    expect(e2323!.summary).toMatch(/Proxy Authentication Required/);

    // Sorted newest first.
    for (let i = 1; i < result.entries.length; i++) {
      expect(
        result.entries[i - 1].date.localeCompare(result.entries[i].date),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns E_NOT_FOUND when neither registry has the package', async () => {
    const out = await handleGetChangelog(
      { package: 'definitely-not-a-real-package-xyz' },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });

  it('honors an explicit ecosystem hint (PyPI skips the npm probe)', async () => {
    let npmCalled = false;
    let pypiCalled = false;
    const deps: GetChangelogDeps = {
      http: { get: async () => '', getJson: async () => ({}) },
      tryNpm: async () => {
        npmCalled = true;
        return npmStripe;
      },
      tryPypi: async (pkg) => {
        pypiCalled = true;
        return pkg === 'requests' ? pypiRequests : null;
      },
      fetchChangelogMd: async (repo) =>
        repo.owner === 'psf' && repo.repo === 'requests' ? requestsChangelogMd : null,
    };
    const out = await handleGetChangelog(
      { package: 'requests', ecosystem: 'pypi' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.ecosystem).toBe('pypi');
    expect(pypiCalled).toBe(true);
    // The explicit `ecosystem: 'pypi'` hint must short-circuit the
    // npm probe — otherwise the npm version of `requests` would
    // win the race.
    expect(npmCalled).toBe(false);
  });

  it('honors an explicit ecosystem hint (npm skips the PyPI probe)', async () => {
    let npmCalled = false;
    let pypiCalled = false;
    const deps: GetChangelogDeps = {
      http: { get: async () => '', getJson: async () => ({}) },
      tryNpm: async (pkg) => {
        npmCalled = true;
        return pkg === 'stripe' ? npmStripe : null;
      },
      tryPypi: async () => {
        pypiCalled = true;
        return pypiRequests;
      },
      fetchChangelogMd: async (repo) =>
        repo.owner === 'stripe' && repo.repo === 'stripe-node' ? stripeChangelogMd : null,
    };
    const out = await handleGetChangelog(
      { package: 'stripe', ecosystem: 'npm' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.ecosystem).toBe('npm');
    expect(npmCalled).toBe(true);
    expect(pypiCalled).toBe(false);
  });

  it('returns E_NOT_FOUND when the explicit ecosystem hint has no package', async () => {
    const out = await handleGetChangelog(
      { package: 'requests', ecosystem: 'pypi' },
      makeDeps({
        tryPypi: async () => null, // simulate 404
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
    expect(out.message).toMatch(/PyPI/);
  });

  it('survives the GitHub fallback being unavailable (no summaries, just version + date)', async () => {
    const out = await handleGetChangelog(
      { package: 'stripe' },
      makeDeps({ fetchChangelogMd: async () => null }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.entries.length).toBeGreaterThan(0);
    for (const entry of out.result.entries) {
      expect(typeof entry.version).toBe('string');
      expect(typeof entry.date).toBe('string');
      // Summary is the package description (filled in from registry).
      expect(typeof entry.summary).toBe('string');
    }
  });
});

describe('AC-4: changelog extractors (unit)', () => {
  it('entriesFromNpm resolves "latest" against dist-tags.latest and sorts newest first', () => {
    const out = entriesFromNpm(npmStripe, 'latest');
    expect(out.resolved).toBe('5.9.0');
    expect(out.entries[0].version).toBe('5.7.0');
    expect(out.entries[0].date).toBe('2024-08-06T18:18:42.000Z');
  });

  it('entriesFromNpm respects a pinned versionSpec', () => {
    const out = entriesFromNpm(npmStripe, '5.0.0');
    expect(out.resolved).toBe('5.0.0');
  });

  it('entriesFromNpm never returns more than 10 entries', () => {
    const out = entriesFromNpm(npmStripe, 'latest');
    expect(out.entries.length).toBeLessThanOrEqual(10);
  });

  it('entriesFromPypi resolves "latest" against info.version', () => {
    const out = entriesFromPypi(pypiRequests, 'latest');
    expect(out.resolved).toBe('2.32.3');
    expect(out.entries[0].version).toBe('2.32.3');
  });

  it('npmTimeMap skips created/modified metadata keys', () => {
    const m = npmTimeMap(npmStripe);
    expect(m.has('created')).toBe(false);
    expect(m.has('modified')).toBe(false);
    expect(m.get('5.0.0')).toBe('2024-04-09T18:24:24.000Z');
  });

  it('pypiTimeMap picks the earliest upload_time per release', () => {
    const m = pypiTimeMap(pypiRequests);
    expect(m.get('2.32.0')).toBe('2024-05-20T15:10:00.000000Z');
  });

  it('entriesFromChangelogMd parses "## 1.2.3 — date" headings', () => {
    const md = '# Changelog\n\n## 1.2.3 — 2024-01-15\n\nFirst release.\n\n## 1.2.2 — 2024-01-01\n\nInitial.\n';
    const out = entriesFromChangelogMd(md);
    expect(out.length).toBe(2);
    expect(out[0].version).toBe('1.2.3');
    expect(out[0].date).toBe('2024-01-15');
    expect(out[0].summary).toMatch(/First release/);
  });

  it('entriesFromChangelogMd parses "[1.2.3] - date" headings', () => {
    const md = '## [1.2.3] - 2024-01-15\n\nBody.\n';
    const out = entriesFromChangelogMd(md);
    expect(out[0].version).toBe('1.2.3');
    expect(out[0].date).toBe('2024-01-15');
  });

  it('mergeSummaries joins registry dates with CHANGELOG summaries by version', () => {
    const registry = [
      { version: '5.0.0', date: '2024-04-09T00:00:00Z', summary: '' },
      { version: '4.9.0', date: '2024-03-01T00:00:00Z', summary: '' },
    ];
    const md = [
      { version: '5.0.0', date: '', summary: 'Big new release.' },
      { version: '4.9.0', date: '', summary: 'Bugfixes.' },
    ];
    const merged = mergeSummaries(registry, md);
    expect(merged[0].summary).toBe('Big new release.');
    expect(merged[0].date).toBe('2024-04-09T00:00:00Z');
    expect(merged[1].summary).toBe('Bugfixes.');
  });

  it('parseGitHubUrl extracts owner/repo from various GitHub URL shapes', () => {
    expect(parseGitHubUrl('git+https://github.com/stripe/stripe-node.git')).toEqual({
      owner: 'stripe',
      repo: 'stripe-node',
      branch: 'main',
    });
    expect(parseGitHubUrl('https://github.com/psf/requests')).toEqual({
      owner: 'psf',
      repo: 'requests',
      branch: 'main',
    });
    expect(parseGitHubUrl('git://github.com/stripe/stripe-node.git')).toEqual({
      owner: 'stripe',
      repo: 'stripe-node',
      branch: 'main',
    });
    expect(parseGitHubUrl('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
    expect(parseGitHubUrl(undefined)).toBeNull();
  });
});
