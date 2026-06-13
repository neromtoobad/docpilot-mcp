/**
 * Playwright-based JS renderer (AC-8).
 *
 * Some documentation sites (Docusaurus, VitePress, Next.js docs,
 * GitBook, etc.) ship a near-empty HTML body that the page's
 * JavaScript fills in at runtime. The static `cheerio` path in
 * `fetchPage.ts` sees only the empty body and would index
 * nothing useful.
 *
 * The detection heuristic (in `isJsRenderedPage`) and the
 * Playwright fallback (in `renderWithJs`) work together: the
 * static path runs first, and only when the heuristic fires
 * does the renderer kick in. Both are deps-injectable so tests
 * can substitute a fake renderer without touching the network
 * or a real browser.
 */
import { debug, info, warn } from '../util/log.js';
import { htmlToText, type FetchedPage } from './fetchPage.js';

export interface RenderedPage {
  url: string;
  title: string;
  text: string;
  html: string;
  /** Which renderer served the response. */
  renderer: 'static' | 'js';
}

export interface RenderWithJsOptions {
  /** Wait for this selector before returning. Default: `body`. */
  waitForSelector?: string;
  /** Wait for this state before returning. Default: `networkidle`. */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Hard timeout for the whole render in ms. Default: 30_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Detection heuristic: should this page be rendered with JS? */
export function isJsRenderedPage(html: string, text: string): boolean {
  // 1. Trivially empty body — almost certainly a SPA shell.
  if (text.length < 50) return true;
  // 2. React 16 mount point. Modern React uses `<div id="root">` or
  //    `<div id="app">`; we check for both the legacy and the
  //    modern patterns so we cover both.
  if (/\bdata-reactroot\b/.test(html)) return true;
  if (/<div[^>]*\bid\s*=\s*["'](?:root|app|__next|__nuxt|___gatsby|ng-app)["']/.test(html) && text.length < 800) {
    return true;
  }
  // 3. <noscript> with a "please enable JavaScript" hint is a
  //    strong signal that the page is JS-rendered.
  if (/<noscript[^>]*>[^<]*enable\s+javascript/i.test(html)) return true;
  // 4. Common SPA bootstrappers that ship a near-empty body.
  if (/__NEXT_DATA__|window\.__NUXT__|window\.gatsby\s*=/.test(html) && text.length < 500) {
    return true;
  }
  return false;
}

/** Default export: the live Playwright-based renderer. */
export async function renderWithJs(
  url: string,
  options: RenderWithJsOptions = {},
): Promise<RenderedPage> {
  const waitForSelector = options.waitForSelector ?? 'body';
  const waitUntil = options.waitUntil ?? 'networkidle';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Dynamic import: Playwright pulls in a lot of native code;
  // we want the static-only path to stay import-light.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    if (waitForSelector !== 'body') {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
    } else {
      // Even with `waitUntil: 'networkidle'`, some pages need a
      // brief moment for client-side hydration to finish. 250 ms
      // is empirically enough for the common SPA frameworks
      // (Docusaurus, VitePress, Next.js) without being
      // noticeable in tests.
      await page.waitForTimeout(250);
    }
    const html = await page.content();
    const title = await page.title();
    const renderedText = await page.evaluate(() =>
      (globalThis as unknown as { document?: { body?: { innerText?: string } } })
        .document?.body?.innerText ?? '',
    );
    const text = htmlToText(renderedText ? `<body>${renderedText}</body>` : html);
    debug(`renderWithJs url=${url} htmlBytes=${html.length} textChars=${text.length}`);
    return { url, title, text, html, renderer: 'js' };
  } finally {
    await browser.close().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      warn(`renderWithJs browser.close failed: ${message}`);
    });
  }
}

/**
 * Decide whether to use the static or JS renderer, and return
 * the rendered page. The static path runs first; if its output
 * looks JS-rendered, we fall back to the Playwright path. Both
 * paths accept the same deps-injectable hooks so tests can
 * substitute fakes.
 */
export interface RenderWithFallbackDeps {
  /** Static (cheerio) fetcher. */
  fetchStatic: (url: string) => Promise<FetchedPage>;
  /** Playwright-based JS renderer. */
  renderJs?: (url: string) => Promise<RenderedPage>;
  /** Override the JS-detection heuristic. */
  isJsRendered?: (html: string, text: string) => boolean;
}

export async function renderWithFallback(
  url: string,
  deps: RenderWithFallbackDeps,
): Promise<RenderedPage> {
  const static_ = await deps.fetchStatic(url);
  const shouldJs = deps.isJsRendered
    ? deps.isJsRendered(static_.html, static_.text)
    : isJsRenderedPage(static_.html, static_.text);
  if (!shouldJs || !deps.renderJs) {
    return { ...static_, renderer: 'static' };
  }
  info(`renderWithFallback url=${url} switched to JS renderer (static text=${static_.text.length} chars)`);
  return await deps.renderJs(url);
}
