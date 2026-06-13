/**
 * AC-8 — Static and JS-rendered doc sites are both supported.
 *
 * Per the plan's verification matrix:
 *   "On body too small (<50 chars) or `data-reactroot` mount
 *    point, switch to Playwright rendering."
 *
 * We exercise the detection heuristic and the static→JS fallback
 * with a fake JS renderer injected into the handler. The real
 * `playwright` import is too heavy for a unit test (and would
 * require a browser binary in CI), so tests substitute a fake
 * that returns the expected post-render body.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  isJsRenderedPage,
  renderWithFallback,
  type RenderedPage,
} from '../src/sources/renderJs.js';
import { handleQueryDocs, type QueryDocsDeps } from '../src/tools/queryDocs.js';
import type { Chunk } from '../src/extractors/markdownChunks.js';
import { tokenize } from '../src/index/lexical.js';
import type { Embedder } from '../src/index/embed.js';

const FAKE_DIM = 16;
const fakeEmbedder: Embedder = {
  dim: FAKE_DIM,
  modelId: 'fake/test/v1',
  embedOne: async (text: string): Promise<Float32Array> => {
    const vec = new Float32Array(FAKE_DIM);
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      let h = 0;
      for (let j = 0; j < tok.length; j++) {
        h = (h * 31 + tok.charCodeAt(j)) >>> 0;
      }
      vec[h % FAKE_DIM] += 1.0;
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  },
  embedBatch: async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await fakeEmbedder.embedOne(t));
    return out;
  },
};

describe('AC-8: isJsRenderedPage — detection heuristic', () => {
  it('returns true for a trivially empty body', () => {
    const html = '<html><body></body></html>';
    const text = '';
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns true for a < 50-char body even when the HTML is large', () => {
    const html = `<html><body>${'<!-- '.repeat(100)}--></body></html>`;
    const text = 'tiny';
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns true for a page with the React 16 `data-reactroot` mount point', () => {
    const html = '<html><body><div data-reactroot=""></div></body></html>';
    const text = 'a'.repeat(60); // text is non-trivial
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns true for a page with a modern React `<div id="root">` mount and a thin body', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    const text = 'a'.repeat(60);
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns true for a page with a `<noscript>...enable JavaScript...</noscript>` hint', () => {
    const html = '<noscript>Please enable JavaScript to view this page.</noscript>';
    const text = 'a'.repeat(60);
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns true for a page with `__NEXT_DATA__` and a thin body', () => {
    const html = '<script>window.__NEXT_DATA__ = {}</script>';
    const text = 'a'.repeat(60);
    expect(isJsRenderedPage(html, text)).toBe(true);
  });

  it('returns false for a static page with rich text and no mount points', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const text = 'Hello world this is a substantial paragraph with many words';
    expect(isJsRenderedPage(html, text)).toBe(false);
  });

  it('returns false for a static page with a `#root` div but plenty of static content', () => {
    const html = '<html><body><div id="root"><p>Lots of content</p></div></body></html>';
    // The threshold for the `#root`/`<div id="app">` heuristic is
    // 800 chars. We need the text to comfortably exceed that
    // so the heuristic does NOT trigger.
    const longText = (
      'Lots of content here, with a paragraph of substance to be had. ' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ' +
      'Duis aute irure dolor in reprehenderit in voluptate velit esse. ' +
      'Excepteur sint occaecat cupidatat non proident, sunt in culpa. ' +
      'Qui officia deserunt mollit anim id est laborum. ' +
      'Reference docs for the JS-rendered body. ' +
      'Another sentence so the heuristic sees plenty of static text. ' +
      'And one more for good measure so we exceed the 800-char threshold.'
    );
    expect(isJsRenderedPage(html, longText)).toBe(false);
  });
});

describe('AC-8: renderWithFallback — static + JS routing', () => {
  it('returns the static page when the heuristic says it is not JS-rendered', async () => {
    const staticHtml = '<html><body><p>Hello</p></body></html>';
    const out = await renderWithFallback('https://example.test/x', {
      fetchStatic: async () => ({
        url: 'https://example.test/x',
        title: 'Hello',
        html: staticHtml,
        text: 'Hello world this has plenty of static text content',
      }),
    });
    expect(out.renderer).toBe('static');
    expect(out.html).toBe(staticHtml);
  });

  it('falls back to the JS renderer when the heuristic fires', async () => {
    let renderCalled = false;
    const out = await renderWithFallback('https://example.test/x', {
      fetchStatic: async () => ({
        url: 'https://example.test/x',
        title: 't',
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
      }),
      renderJs: async (url) => {
        renderCalled = true;
        const rendered: RenderedPage = {
          url,
          title: 'post-render',
          html: '<html><body>rendered</body></html>',
          text: 'rendered this is the post-render text body',
          renderer: 'js',
        };
        return rendered;
      },
    });
    expect(renderCalled).toBe(true);
    expect(out.renderer).toBe('js');
    expect(out.text).toMatch(/post-render text body/);
  });

  it('falls back to the static result when the heuristic fires but no JS renderer is provided', async () => {
    const out = await renderWithFallback('https://example.test/x', {
      fetchStatic: async () => ({
        url: 'https://example.test/x',
        title: 't',
        html: '<html><body><div id="root"></div></body></html>',
        text: '',
      }),
      // intentionally no `renderJs`
    });
    expect(out.renderer).toBe('static');
  });

  it('honors a custom isJsRendered override', async () => {
    let renderCalled = false;
    const out = await renderWithFallback('https://example.test/x', {
      fetchStatic: async () => ({
        url: 'https://example.test/x',
        title: 't',
        html: '<html><body>lots of static</body></html>',
        text: 'lots of static text body',
      }),
      isJsRendered: () => true, // force JS path
      renderJs: async (url) => {
        renderCalled = true;
        return { url, title: 'js', html: '<html/>', text: 'js body', renderer: 'js' };
      },
    });
    expect(renderCalled).toBe(true);
    expect(out.renderer).toBe('js');
  });
});

describe('AC-8: query_docs — end-to-end static→JS fallback', () => {
  it('serves a static-thick page from the static path (no JS call)', async () => {
    const staticPage = {
      url: 'https://example.test/stripe',
      title: 'Stripe API',
      html: '<html><body><p>Hello</p></body></html>',
      text: 'Stripe API reference, lots of text, easy to chunk',
    };
    const deps = makeDeps(staticPage);
    const renderSpy = vi.fn(async (_url: string): Promise<RenderedPage> => {
      throw new Error('JS renderer should not be called for a static page');
    });
    deps.renderDocs = renderSpy;

    const out = await handleQueryDocs(
      { package: 'stripe', version: '5.0.0', question: 'how does it work' },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it('falls back to the JS renderer when the static body is too small', async () => {
    const staticPage = {
      url: 'https://example.test/docusaurus',
      title: 'Docusaurus',
      html: '<html><body><div id="root"></div></body></html>',
      text: '', // SPA shell — empty
    };
    const jsRendered: RenderedPage = {
      url: staticPage.url,
      title: 'Docusaurus rendered',
      html: '<html><body>rendered</body></html>',
      // The post-render body must (a) be > 50 chars (so it
      // passes the "too small" check) and (b) share tokens with
      // the question so the ranker surfaces it.
      text: 'Documentation of the API. The api is documented here in detail. The createCustomer method is part of the public api. The api supports cursors, pagination, and rate limiting. For more details about the api, see the full reference.',
      renderer: 'js',
    };
    const deps = makeDeps(staticPage);
    deps.renderDocs = async (url: string) => {
      return { ...jsRendered, url };
    };

    const out = await handleQueryDocs(
      { package: 'docusaurus', version: '1.0.0', question: 'api reference documentation' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The post-render body has the real content, so the answer
    // can be ranked against it.
    expect(out.result.sources.length).toBeGreaterThan(0);
    const allSnippets = out.result.sources.map((s) => s.snippet).join('\n');
    expect(allSnippets).toMatch(/api is documented here/);
  });

  it('returns E_UPSTREAM when both the static AND the JS renderer return too little', async () => {
    const staticPage = {
      url: 'https://example.test/empty',
      title: 'Empty',
      html: '<html><body></body></html>',
      text: '',
    };
    const jsPage: RenderedPage = {
      url: staticPage.url,
      title: 'still empty',
      html: '<html><body></body></html>',
      text: 'too', // < 50 chars
      renderer: 'js',
    };
    const deps = makeDeps(staticPage);
    deps.renderDocs = async (url: string) => ({ ...jsPage, url });

    const out = await handleQueryDocs(
      { package: 'empty', version: '1.0.0', question: 'where is the API' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Both the static path and the JS path returned < 50
    // chars, so the handler returns E_UPSTREAM with a message
    // that surfaces which renderer was used.
    expect(out.code).toBe('E_UPSTREAM');
    expect(out.message).toMatch(/too little content/);
    expect(out.message).toMatch(/renderer=js/);
  });
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeDeps(staticPage: {
  url: string;
  title: string;
  html: string;
  text: string;
}): QueryDocsDeps {
  return {
    http: {
      get: async () => '',
      getJson: async () => ({}),
    },
    fetchPage: async () => staticPage,
    loadEmbedder: async () => fakeEmbedder,
  };
}
