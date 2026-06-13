/**
 * Fetch a docs page and return a text-only "markdown-ish" view of it.
 *
 * AC-3 only needs the static / cheerio path; AC-8 will add the
 * Playwright fallback (when the page is JS-rendered, the body has
 * fewer than 50 chars, or it contains a `data-reactroot` mount point).
 */
import * as cheerio from 'cheerio';
import type { HttpClient } from '../net/httpClient.js';

export interface FetchedPage {
  url: string;
  title: string;
  /** Plain-text body, with all scripts/styles/navigation stripped. */
  text: string;
  /** Original HTML, for evidence / debugging. */
  html: string;
}

export interface FetchPageOptions {
  /** Max body length (chars) to keep. Default 200_000 (~50k tokens). */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 200_000;

/** Fetch a URL and reduce it to text + a small HTML payload. */
export async function fetchPage(
  http: HttpClient,
  url: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const html = await http.get(url);
  const text = htmlToText(html, options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS);
  const title = extractTitle(html);
  return { url, title, text, html };
}

/** Convert raw HTML to a clean plain-text view. */
export function htmlToText(html: string, maxChars: number = DEFAULT_MAX_BODY_CHARS): string {
  const $ = cheerio.load(html);
  // Remove noise we never want indexed.
  $(
    'script, style, noscript, iframe, svg, canvas, ' +
      'header nav, footer, aside, [role="navigation"], [aria-hidden="true"]',
  ).remove();
  // Promote headings to plain text lines so the chunker's section
  // splitter can pick them up.
  $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
    const level = parseInt(el.tagName.slice(1), 10);
    const text = $(el).text().trim();
    if (text.length > 0) {
      $(el).text(`\n\n${'#'.repeat(level)} ${text}\n\n`);
    }
  });
  // Convert <p>, <li>, <pre>, <code>, <br> to plain text with breaks.
  $('p, li, pre, blockquote, tr').each((_i, el) => {
    const node = $(el);
    node.text(`\n${node.text().trim()}\n`);
  });
  $('br').replaceWith('\n');

  const text = $('body').text() || $.root().text();
  // Normalize whitespace and clamp to maxChars.
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function extractTitle(html: string): string {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:title"]').attr('content');
  if (og) return og.trim();
  const t = $('title').first().text().trim();
  if (t) return t;
  const h1 = $('h1').first().text().trim();
  return h1 || '(untitled)';
}
