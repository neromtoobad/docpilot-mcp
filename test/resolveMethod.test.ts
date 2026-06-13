/**
 * AC-6 — `resolve_method` returns the current signature for a
 * method in a pinned package version.
 *
 * Per the plan's verification matrix:
 *   "For `stripe@5.0.0` `customers.create`, `signature` matches
 *    the `.d.ts` declaration; calling with a non-existent method
 *    returns `E_NOT_FOUND`."
 *
 * We exercise the documented output contract against the recorded
 * fixtures under `test/fixtures/sources/`. Every `tryNpm`,
 * `tryPypi`, `loadPackageFiles` is overridden so the test never
 * touches the network and never depends on the live state of the
 * real packages' tarballs/wheels.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  handleResolveMethod,
  type ResolveMethodDeps,
} from '../src/tools/resolveMethod.js';
import { findSignatureInDts } from '../src/extractors/ts.js';
import { findSignatureInPy } from '../src/extractors/py.js';
import type { NpmPackageInfo } from '../src/sources/registry/npm.js';
import type { PypiPackageInfo } from '../src/sources/registry/pypi.js';
import type { ExtractedFileMap } from '../src/extractors/source.js';

import npmStripeFixture from './fixtures/registry/npm-stripe.json' with { type: 'json' };
import pypiRequestsFixture from './fixtures/registry/pypi-requests.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const STRIPE_DTS_CUSTOMERS = readFileSync(
  join(HERE, 'fixtures/sources/stripe/types/CustomersResource.d.ts'),
  'utf8',
);
const STRIPE_DTS_INDEX = readFileSync(
  join(HERE, 'fixtures/sources/stripe/types/index.d.ts'),
  'utf8',
);
const REQUESTS_SESSIONS_PY = readFileSync(
  join(HERE, 'fixtures/sources/requests/sessions.py'),
  'utf8',
);
const REQUESTS_API_PY = readFileSync(
  join(HERE, 'fixtures/sources/requests/api.py'),
  'utf8',
);

const npmStripe = npmStripeFixture as unknown as NpmPackageInfo;
const pypiReq = pypiRequestsFixture as unknown as PypiPackageInfo;

const STRIPE_FILES: ExtractedFileMap = new Map([
  ['types/CustomersResource.d.ts', STRIPE_DTS_CUSTOMERS],
  ['types/index.d.ts', STRIPE_DTS_INDEX],
]);
const REQUESTS_FILES: ExtractedFileMap = new Map([
  ['requests/sessions.py', REQUESTS_SESSIONS_PY],
  ['requests/api.py', REQUESTS_API_PY],
]);

function makeDeps(
  overrides: Partial<ResolveMethodDeps> = {},
): ResolveMethodDeps {
  return {
    http: {
      get: async () => '',
      getJson: async () => ({}),
    },
    tryNpm: async (pkg) => (pkg === 'stripe' ? npmStripe : null),
    tryPypi: async (pkg) => (pkg === 'requests' ? pypiReq : null),
    loadPackageFiles: async (ecosystem, pkg) => {
      if (ecosystem === 'npm' && pkg === 'stripe') return STRIPE_FILES;
      if (ecosystem === 'pypi' && pkg === 'requests') return REQUESTS_FILES;
      return null;
    },
    extractFromTs: findSignatureInDts,
    extractFromPy: findSignatureInPy,
    ...overrides,
  };
}

describe('AC-6: resolve_method — current signature for a pinned method', () => {
  it('npm stripe@5.0.0 customers.create: returns the documented output shape with the literal .d.ts signature', async () => {
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: 'customers.create' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { result } = out;
    expect(result.package).toBe('stripe');
    expect(result.version).toBe('5.0.0');
    expect(result.method).toBe('customers.create');

    // AC-6: signature is the literal source text of the .d.ts
    // declaration. Our fixture has it on a single line, so we
    // assert the function name + the param name + the return type.
    expect(result.signature).toMatch(/create\s*\(/);
    expect(result.signature).toMatch(/params: CustomerCreateParams/);
    expect(result.signature).toMatch(/: Promise<Customer>/);

    // AC-6: params is the parsed parameter list, with name,
    // type, required, and (eventual) description. The first
    // parameter is `params`, the second is the optional
    // `options`.
    expect(result.params.length).toBe(2);
    expect(result.params[0].name).toBe('params');
    expect(result.params[0].type).toBe('CustomerCreateParams');
    expect(result.params[0].required).toBe(true);
    expect(result.params[1].name).toBe('options');
    expect(result.params[1].type).toBe('RequestOptions');
    expect(result.params[1].required).toBe(false);

    // AC-6: returns is the declared return type.
    expect(result.returns).toBe('Promise<Customer>');

    // AC-6: source.path is the relative path inside the
    // tarball, source.line is the 1-indexed line of the
    // declaration.
    expect(result.source.path).toMatch(/CustomersResource\.d\.ts$/);
    expect(result.source.line).toBeGreaterThan(0);
    expect(typeof result.source.url).toBe('string');
    // The URL should be a stable, deterministic pointer to the
    // artifact (unpkg.com for npm).
    expect(result.source.url).toMatch(/^https:\/\/unpkg\.com\//);
  });

  it('pypi requests@2.32.3 Session.get: returns the Python signature extracted from .py source', async () => {
    const out = await handleResolveMethod(
      { package: 'requests', version: '2.32.3', method: 'Session.get', ecosystem: 'pypi' },
      makeDeps(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { result } = out;
    expect(result.package).toBe('requests');
    expect(result.version).toBe('2.32.3');
    expect(result.method).toBe('Session.get');
    expect(result.signature).toMatch(/def get\(self, url: str/);
    expect(result.params[0].name).toBe('self');
    expect(result.params[1].name).toBe('url');
    expect(result.params[1].type).toBe('str');
    expect(result.returns).toMatch(/Response/);
    expect(result.source.path).toMatch(/sessions\.py$/);
    expect(result.source.line).toBeGreaterThan(0);
    expect(result.source.url).toMatch(/^https:\/\/files\.pythonhosted\.org\//);
  });

  it('honors the explicit ecosystem: npm hint (skips the PyPI probe)', async () => {
    let npmCalled = false;
    let pypiCalled = false;
    const deps = makeDeps({
      tryNpm: async (pkg) => {
        npmCalled = true;
        return pkg === 'stripe' ? npmStripe : null;
      },
      tryPypi: async () => {
        pypiCalled = true;
        return pypiReq;
      },
    });
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: 'customers.create', ecosystem: 'npm' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(npmCalled).toBe(true);
    expect(pypiCalled).toBe(false);
  });

  it('returns E_NOT_FOUND when the method does not exist in the package', async () => {
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: 'customers.noSuchMethod' },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
    expect(out.message).toMatch(/not found/i);
  });

  it('returns E_NOT_FOUND when the package is not in either registry', async () => {
    const out = await handleResolveMethod(
      { package: 'definitely-not-a-real-package-xyz', version: '1.0.0', method: 'foo' },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });

  it('returns E_NOT_FOUND when the package has no resolvable source files', async () => {
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: 'customers.create' },
      makeDeps({ loadPackageFiles: async () => null }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });

  it('rejects empty / malformed method paths with E_INVALID_INPUT', async () => {
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: '' },
      makeDeps(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_INVALID_INPUT');

    const out2 = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: '123-bad' },
      makeDeps(),
    );
    expect(out2.ok).toBe(false);
    if (out2.ok) return;
    expect(out2.code).toBe('E_INVALID_INPUT');
  });

  it('never silently falls back to a different version (MethodNotFound stays MethodNotFound)', async () => {
    // The handler should NOT try other versions when the requested
    // version's files don't contain the method. We simulate that
    // by returning a single file that lacks the method, and the
    // handler should return E_NOT_FOUND.
    const out = await handleResolveMethod(
      { package: 'stripe', version: '5.0.0', method: 'customers.create' },
      makeDeps({
        loadPackageFiles: async () =>
          new Map([['types/empty.d.ts', 'export interface Empty {}']]),
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('E_NOT_FOUND');
  });
});

describe('AC-6: resolve_method — extractors (unit)', () => {
  it('findSignatureInDts: returns null when the method is not in the .d.ts', () => {
    const result = findSignatureInDts(
      'export interface Empty {}',
      'missing.method',
      'empty.d.ts',
    );
    expect(result).toBeNull();
  });

  it('findSignatureInDts: returns the literal source for a typed method signature', () => {
    const dts = `
      export interface Resource {
        create(params: { foo: string }): Promise<void>;
      }
    `;
    const result = findSignatureInDts(dts, 'create', 'res.d.ts');
    expect(result).not.toBeNull();
    expect(result!.signature).toMatch(/create\(params:/);
    expect(result!.params[0].name).toBe('params');
    expect(result!.params[0].type).toBe('{ foo: string }');
    expect(result!.params[0].required).toBe(true);
    expect(result!.returns).toBe('Promise<void>');
  });

  it('findSignatureInPy: extracts a method from a class', () => {
    const py = `
class Foo:
    def bar(self, x: int) -> str:
        return str(x)
`;
    const result = findSignatureInPy(py, 'Foo.bar', 'foo.py');
    expect(result).not.toBeNull();
    expect(result!.signature).toMatch(/def bar\(self, x: int\) -> str:/);
    expect(result!.params.map((p) => p.name)).toEqual(['self', 'x']);
    expect(result!.params[1].type).toBe('int');
    expect(result!.returns).toBe('str');
  });

  it('findSignatureInPy: returns null when the method is absent', () => {
    const py = `
class Foo:
    def bar(self) -> None: pass
`;
    const result = findSignatureInPy(py, 'Foo.baz', 'foo.py');
    expect(result).toBeNull();
  });

  it('findSignatureInPy: handles a top-level function', () => {
    const py = `
def helper(name: str) -> int:
    return len(name)
`;
    const result = findSignatureInPy(py, 'helper', 'foo.py');
    expect(result).not.toBeNull();
    expect(result!.params[0].name).toBe('name');
    expect(result!.returns).toBe('int');
  });

  it('findSignatureInPy: kwargs are not required', () => {
    const py = `
def helper(**kwargs): pass
`;
    const result = findSignatureInPy(py, 'helper', 'foo.py');
    expect(result).not.toBeNull();
    const kwarg = result!.params.find((p) => p.name === '**kwargs');
    expect(kwarg).toBeDefined();
    expect(kwarg!.required).toBe(false);
  });
});
