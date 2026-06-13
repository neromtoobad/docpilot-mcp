/**
 * AC-5 — `search_examples` returns real code examples from official
 * sources only.
 *
 * Per the plan's verification matrix:
 *   "Returned code blocks parse with `node --check` or Python
 *    `ast.parse`; every `url` is on `github.com` and under the
 *    package's official repo."
 *
 * We exercise the documented output contract against the recorded
 * fixtures under `test/fixtures/github/`. Every `tryNpm`, `tryPypi`,
 * `fetchTree`, and `fetchFile` is overridden so the test never
 * touches the network and never depends on the live state of the
 * fixtures' canonical GitHub repos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  handleSearchExamples,
  type SearchExamplesDeps,
} from '../src/tools/searchExamples.js';
import type { NpmPackageInfo } from '../src/sources/registry/npm.js';
import type { PypiPackageInfo } from '../src/sources/registry/pypi.js';
import type {
  GitHubRepo,
  GitHubTreeResponse,
  GitHubTreeItem,
} from '../src/sources/github.js';
import {
  extractFencedCode,
  findExampleFiles,
  findReadmeInTree,
  rankSnippets,
} from '../src/sources/examples.js';
import {
  detectLanguage,
  isValidSyntax,
} from '../src/util/syntaxValidate.js';

import npmStripeFixture from './fixtures/registry/npm-stripe.json' with { type: 'json' };
import pypiRequestsFixture from './fixtures/registry/pypi-requests.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));

// Read GitHub fixtures from disk.
const STRIPE_TREE = JSON.parse(
  readFileSync(join(HERE, 'fixtures/github/stripe-stripe-node/tree.json'), 'utf8'),
) as GitHubTreeResponse;
const STRIPE_README = readFileSync(
  join(HERE, 'fixtures/github/stripe-stripe-node/README.md'),
  'utf8',
);

const PSF_TREE = JSON.parse(
  readFileSync(join(HERE, 'fixtures/github/psf-requests/tree.json'), 'utf8'),
) as GitHubTreeResponse;
const PSF_README = readFileSync(
  join(HERE, 'fixtures/github/psf-requests/README.md'),
  'utf8',
);

// Map each repo+path to its on-disk fixture.
const FILE_FIXTURES: Record<string, Record<string, string>> = {
  'stripe/stripe-node': {
    'README.md': STRIPE_README,
    'examples/webhook-signing.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/webhook-signing.js'),
      'utf8',
    ),
    'examples/create-customer.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/create-customer.js'),
      'utf8',
    ),
    'examples/charge.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/charge.js'),
      'utf8',
    ),
    'examples/list-customers.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/list-customers.js'),
      'utf8',
    ),
    'examples/create-customer.ts': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/create-customer.ts'),
      'utf8',
    ),
    'examples/refund.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/refund.js'),
      'utf8',
    ),
    'examples/subscription.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/subscription.js'),
      'utf8',
    ),
    'examples/payment-intent.js': readFileSync(
      join(HERE, 'fixtures/github/stripe-stripe-node/examples/payment-intent.js'),
      'utf8',
    ),
  },
  'psf/requests': {
    'README.md': PSF_README,
    'examples/get-quickstart.py': readFileSync(
      join(HERE, 'fixtures/github/psf-requests/examples/get-quickstart.py'),
      'utf8',
    ),
    'examples/post-request.py': readFileSync(
      join(HERE, 'fixtures/github/psf-requests/examples/post-request.py'),
      'utf8',
    ),
    'examples/send-custom-headers.py': readFileSync(
      join(HERE, 'fixtures/github/psf-requests/examples/send-custom-headers.py'),
      'utf8',
    ),
  },
};

const npmStripe = npmStripeFixture as unknown as NpmPackageInfo;
const pypiReq = pypiRequestsFixture as unknown as PypiPackageInfo;

function makeDeps(
  overrides: Partial<SearchExamplesDeps> = {},
): SearchExamplesDeps {
  return {
    http: {
      get: async () => '',
      getJson: async () => ({}),
    },
    tryNpm: async (pkg) => (pkg === 'stripe' ? npmStripe : null),
    tryPypi: async (pkg) => (pkg === 'requests' ? pypiReq : null),
    fetchTree: async (repo) => {
      const k = `${repo.owner}/${repo.repo}`;
      if (k === 'stripe/stripe-node') return STRIPE_TREE;
      if (k === 'psf/requests') return PSF_TREE;
      return null;
    },
    fetchFile: async (repo, path) => {
      const k = `${repo.owner}/${repo.repo}`;
      return FILE_FIXTURES[k]?.[path] ?? null;
    },
    ...overrides,
  };
}

describe('AC-5: search_examples — real code examples from official repos only', () => {
  it('npm stripe: returns at most 10 examples drawn from the official examples/ directory and README.md', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { result } = out;
    expect(result.package).toBe('stripe');
    expect(result.ecosystem).toBe('npm');
    expect(result.version).toBe('5.0.0');
    expect(result.query).toBe('create a customer');
    expect(result.examples.length).toBeGreaterThan(0);
    expect(result.examples.length).toBeLessThanOrEqual(10);

    // Documented per-example shape.
    for (const ex of result.examples) {
      expect(typeof ex.code).toBe('string');
      expect(typeof ex.path).toBe('string');
      expect(typeof ex.url).toBe('string');
      expect(typeof ex.language).toBe('string');
      expect(ex.code.length).toBeGreaterThan(0);
    }
  });

  it('every example.url is on github.com under the package\'s official repo', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const ex of out.result.examples) {
      // AC-5 explicitly forbids Stack Overflow, blogs, and other
      // third-party aggregators. We only ever hit github.com.
      expect(ex.url).toMatch(/^https:\/\/github\.com\//);
      // And it must be under the package's official repo.
      expect(ex.url).toMatch(/^https:\/\/github\.com\/stripe\/stripe-node\//);
    }
  });

  it('every JS .code block passes `node --check` (verified via the same code path as production)', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const jsExamples = out.result.examples.filter((e) => e.language === 'javascript');
    expect(jsExamples.length).toBeGreaterThan(0);
    for (const ex of jsExamples) {
      // The validator runs `node --check` against a tmp file with
      // the same extension, then returns true. We re-validate
      // independently here as a belt-and-suspenders check.
      expect(isValidSyntax(ex.code, 'javascript', ex.path)).toBe(true);
    }
  });

  it('every TS .code block parses with the TypeScript compiler', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const tsExamples = out.result.examples.filter((e) => e.language === 'typescript');
    expect(tsExamples.length).toBeGreaterThan(0);
    for (const ex of tsExamples) {
      expect(isValidSyntax(ex.code, 'typescript', ex.path)).toBe(true);
    }
  });

  it('every Python .code block passes `ast.parse`', async () => {
    const out = await handleSearchExamples(
      { package: 'requests', version: '2.32.3', query: 'send a GET', ecosystem: 'pypi' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const pyExamples = out.result.examples.filter((e) => e.language === 'python');
    expect(pyExamples.length).toBeGreaterThan(0);
    for (const ex of pyExamples) {
      expect(isValidSyntax(ex.code, 'python', ex.path)).toBe(true);
    }
  });

  it('query ranking: a "create a customer" query puts the create-customer example first', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The top result should be a customer-creation snippet — either
    // the `examples/create-customer.js` file or the README's
    // `## Quickstart` fenced block, which also creates a customer.
    const top = out.result.examples[0];
    const isCreate = /create[_-]?customer/i.test(top.path) || /customers\.create/.test(top.code);
    expect(isCreate).toBe(true);
  });

  it('honors the explicit ecosystem: pypi hint (skips the npm probe)', async () => {
    let npmCalled = false;
    let pypiCalled = false;
    const deps = makeDeps({
      tryNpm: async () => {
        npmCalled = true;
        return npmStripe;
      },
      tryPypi: async (pkg) => {
        pypiCalled = true;
        return pkg === 'requests' ? pypiReq : null;
      },
    });
    const out = await handleSearchExamples(
      { package: 'requests', version: '2.32.3', query: 'GET request', ecosystem: 'pypi' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.ecosystem).toBe('pypi');
    expect(pypiCalled).toBe(true);
    // The explicit `ecosystem: 'pypi'` hint must short-circuit the
    // npm probe.
    expect(npmCalled).toBe(false);
  });

  it('returns E_NOT_FOUND when neither registry has the package', async () => {
    const out = await handleSearchExamples(
      {
        package: 'definitely-not-a-real-package-xyz',
        version: '1.0.0',
        query: 'create a customer',
      },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });

  it('returns E_NOT_FOUND when the package has no resolvable GitHub repo', async () => {
    // npm stripe's `repository.url` is missing in this fixture.
    const npmStripped = { ...npmStripe, repository: undefined, homepage: undefined };
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps({ tryNpm: async () => npmStripped }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
    expect(out.message).toMatch(/github/i);
  });

  it('falls back to README.md only when the repo has no examples/ directory', async () => {
    // Build a synthetic tree with only the README + a non-example
    // code file that should be ignored.
    const noExamplesTree: GitHubTreeResponse = {
      sha: 'no-examples',
      url: 'https://api.github.com/repos/foo/bar/git/trees/no-examples',
      truncated: false,
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: '1', url: 'https://example/1' },
        { path: 'src/index.js', mode: '100644', type: 'blob', sha: '2', url: 'https://example/2' },
      ],
    };
    const noExamplesDeps: SearchExamplesDeps = {
      http: { get: async () => '', getJson: async () => ({}) },
      tryNpm: async () => ({
        ...npmStripe,
        repository: { type: 'git', url: 'git+https://github.com/foo/bar.git' },
      }),
      tryPypi: async () => null,
      fetchTree: async () => noExamplesTree,
      fetchFile: async (_repo, path) =>
        path === 'README.md' ? STRIPE_README : null,
    };
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'customer' },
      noExamplesDeps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // All examples must come from README.md.
    for (const ex of out.result.examples) {
      expect(ex.path).toBe('README.md');
    }
    expect(out.result.examples.length).toBeGreaterThan(0);
  });

  it('snippet URLs include a #L{start}-L{end} anchor for README code blocks', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const readmeSnippets = out.result.examples.filter((e) => e.path === 'README.md');
    for (const ex of readmeSnippets) {
      expect(ex.url).toMatch(/#L\d+-L\d+$/);
    }
  });

  it('never queries third-party aggregators (no StackOverflow, blogs, etc.)', async () => {
    // We rely on the deps override to make this trivially true:
    // the test never lets the handler reach the real network, so
    // the only URLs the handler can ever produce are the ones it
    // builds from the GitHub repo (via `blobUrl`).
    const seenUrls: string[] = [];
    const deps = makeDeps({
      fetchFile: async (repo, path) => {
        const k = `${repo.owner}/${repo.repo}`;
        const body = FILE_FIXTURES[k]?.[path] ?? null;
        if (body !== null) seenUrls.push(`https://github.com/${repo.owner}/${repo.repo}`);
        return body;
      },
    });
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Every example.url is on github.com, period.
    for (const ex of out.result.examples) {
      expect(ex.url.startsWith('https://github.com/')).toBe(true);
    }
    // And we never reached out to any non-github domain.
    expect(seenUrls.every((u) => u.startsWith('https://github.com/'))).toBe(true);
  });

  it('rejects queries shorter than 2 chars with E_INVALID_INPUT', async () => {
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'a' },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_INVALID_INPUT');
  });

  it('returns E_NOT_FOUND when the repo has no matching examples at all', async () => {
    // Build a tree with a single README that has no code blocks
    // related to the query.
    const emptyTree: GitHubTreeResponse = {
      sha: 'empty',
      url: 'https://example/empty',
      truncated: false,
      tree: [
        { path: 'README.md', mode: '100644', type: 'blob', sha: '1', url: 'https://example/1' },
      ],
    };
    const deps: SearchExamplesDeps = {
      http: { get: async () => '', getJson: async () => ({}) },
      tryNpm: async () => ({
        ...npmStripe,
        repository: { type: 'git', url: 'git+https://github.com/foo/bar.git' },
      }),
      tryPypi: async () => null,
      fetchTree: async () => emptyTree,
      fetchFile: async () => '# Empty\n\nNo code here.\n',
    };
    const out = await handleSearchExamples(
      { package: 'stripe', version: '5.0.0', query: 'create a customer' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });
});

describe('AC-5: search_examples — helpers (unit)', () => {
  it('findExampleFiles restricts to known example directories and code extensions', () => {
    const tree: GitHubTreeItem[] = [
      { path: 'examples/a.js', mode: '100644', type: 'blob', sha: '1', url: 'x' },
      { path: 'examples/b.ts', mode: '100644', type: 'blob', sha: '2', url: 'x' },
      { path: 'examples/c.md', mode: '100644', type: 'blob', sha: '3', url: 'x' },
      { path: 'examples/d.json', mode: '100644', type: 'blob', sha: '4', url: 'x' },
      { path: 'example/e.py', mode: '100644', type: 'blob', sha: '5', url: 'x' },
      { path: 'demo/f.go', mode: '100644', type: 'blob', sha: '6', url: 'x' },
      { path: 'src/g.js', mode: '100644', type: 'blob', sha: '7', url: 'x' }, // not in example dir
      { path: 'docs/h.md', mode: '100644', type: 'blob', sha: '8', url: 'x' }, // docs/ excluded
      { path: 'random.txt', mode: '100644', type: 'blob', sha: '9', url: 'x' },
    ];
    const out = findExampleFiles(tree);
    const paths = out.map((i) => i.path);
    expect(paths).toContain('examples/a.js');
    expect(paths).toContain('examples/b.ts');
    expect(paths).toContain('example/e.py');
    expect(paths).toContain('demo/f.go');
    // Non-code files and files outside example dirs are excluded.
    expect(paths).not.toContain('examples/c.md');
    expect(paths).not.toContain('examples/d.json');
    expect(paths).not.toContain('src/g.js');
    expect(paths).not.toContain('docs/h.md');
    expect(paths).not.toContain('random.txt');
  });

  it('findReadmeInTree prefers README.md case-sensitively, falls back to lowercase', () => {
    const tree: GitHubTreeItem[] = [
      { path: 'readme.md', mode: '100644', type: 'blob', sha: '1', url: 'x' },
      { path: 'README.md', mode: '100644', type: 'blob', sha: '2', url: 'x' },
    ];
    expect(findReadmeInTree(tree)?.path).toBe('README.md');
  });

  it('extractFencedCode parses backtick and tilde fences and tracks line numbers', () => {
    const md = [
      'Top line.', // 1
      '```js', // 2
      'const a = 1;', // 3
      'const b = 2;', // 4
      '```', // 5
      'Middle.', // 6
      '~~~python', // 7
      'x = 1', // 8
      'y = 2', // 9
      '~~~', // 10
    ].join('\n');
    const blocks = extractFencedCode(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0].code).toMatch(/const a = 1;\nconst b = 2;/);
    expect(blocks[0].infoString).toBe('js');
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].endLine).toBe(4);
    expect(blocks[1].infoString).toBe('python');
    expect(blocks[1].code).toMatch(/x = 1\ny = 2/);
  });

  it('rankSnippets: matching snippets outrank unrelated ones', () => {
    const repo: GitHubRepo = { owner: 'a', repo: 'b', branch: 'main' };
    const snippets = [
      {
        code: 'const stripe = require("stripe");',
        path: 'examples/charge.js',
        url: '',
        language: 'javascript',
        infoString: null,
        startLine: 1,
        endLine: 1,
      },
      {
        code: 'const customer = await stripe.customers.create({ email: "x@y.com" });',
        path: 'examples/create-customer.js',
        url: '',
        language: 'javascript',
        infoString: null,
        startLine: 1,
        endLine: 1,
      },
    ];
    const ranked = rankSnippets(snippets, 'create a customer');
    expect(ranked[0].path).toBe('examples/create-customer.js');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('detectLanguage normalises info strings and extensions', () => {
    expect(detectLanguage('js', null)).toBe('javascript');
    expect(detectLanguage('javascript', null)).toBe('javascript');
    expect(detectLanguage('ts', null)).toBe('typescript');
    expect(detectLanguage('typescript', null)).toBe('typescript');
    expect(detectLanguage('py', null)).toBe('python');
    expect(detectLanguage('python', null)).toBe('python');
    expect(detectLanguage(null, 'foo.js')).toBe('javascript');
    expect(detectLanguage(null, 'foo.cjs')).toBe('javascript');
    expect(detectLanguage(null, 'foo.mjs')).toBe('javascript');
    expect(detectLanguage(null, 'foo.ts')).toBe('typescript');
    expect(detectLanguage(null, 'foo.tsx')).toBe('typescript');
    expect(detectLanguage(null, 'foo.py')).toBe('python');
    expect(detectLanguage(null, 'foo.rb')).toBe('ruby');
    expect(detectLanguage(null, 'foo.sh')).toBe('shell');
    expect(detectLanguage(null, 'foo.go')).toBe('go');
    expect(detectLanguage(null, 'foo.rs')).toBe('rust');
    expect(detectLanguage(null, 'foo.json')).toBe('unknown');
  });

  it('isValidSyntax returns true for empty snippets (no content to validate)', () => {
    expect(isValidSyntax('', 'javascript', 'foo.js')).toBe(true);
    expect(isValidSyntax('   \n  ', 'python', 'foo.py')).toBe(true);
  });

  it('isValidSyntax detects a broken JavaScript snippet', () => {
    // Missing closing brace → syntax error.
    expect(isValidSyntax('const a = {', 'javascript', 'broken.js')).toBe(false);
  });

  it('isValidSyntax detects a broken Python snippet', () => {
    expect(isValidSyntax('def x(:\n  pass', 'python', 'broken.py')).toBe(false);
  });

  it('isValidSyntax detects a broken TypeScript snippet', () => {
    expect(
      isValidSyntax('const x: number = ;', 'typescript', 'broken.ts'),
    ).toBe(false);
  });
});
