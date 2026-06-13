/**
 * Search example files in a package's official GitHub repository.
 *
 * AC-5 restricts the source to:
 *   - the repo's `examples/`, `example/`, `demo/`, `demos/`, or
 *     `sample/` directory, and
 *   - the repo's `README.md` (fenced code blocks).
 *
 * No third-party aggregators. We only ever hit the official repo.
 *
 * The output is a list of `ExampleSnippet`s ranked by relevance to
 * the user's query. The handler in `src/tools/searchExamples.ts`
 * trims to 10 and validates syntax before returning.
 */
import { tokenize } from '../index/lexical.js';
import type { GitHubRepo, GitHubTreeItem } from './github.js';

/** A single code snippet surfaced by the search. */
export interface ExampleSnippet {
  /** Code text. */
  code: string;
  /** Path inside the repo (e.g. `examples/webhook.js` or `README.md`). */
  path: string;
  /** Canonical URL on github.com to view the file. */
  url: string;
  /** Language tag, e.g. `javascript`, `typescript`, `python`. */
  language: string;
  /** Original info string (for README code blocks) or `null`. */
  infoString: string | null;
  /** 1-indexed line numbers inside the file (for README code blocks). */
  startLine: number;
  endLine: number;
}

/** Directories we look for in the tree, in priority order. */
export const EXAMPLE_DIR_CANDIDATES = [
  'examples',
  'example',
  'demos',
  'demo',
  'samples',
  'sample',
] as const;

/** File extensions we treat as code (others are skipped). */
const CODE_EXTENSIONS = new Set([
  'js',
  'cjs',
  'mjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'sh',
  'bash',
  'zsh',
  'kt',
  'swift',
  'java',
  'cs',
  'php',
  'pl',
  'lua',
  'ex',
  'exs',
  'clj',
  'scala',
]);

/**
 * Find file paths under any of the example directories in a tree.
 * Returns paths with their blob entries so the caller can decide
 * how to fetch them. Results are deterministic (sorted by path).
 */
export function findExampleFiles(
  tree: GitHubTreeItem[],
  maxResults: number = 200,
): GitHubTreeItem[] {
  const out: GitHubTreeItem[] = [];
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const path = item.path.toLowerCase();
    const firstSlash = path.indexOf('/');
    if (firstSlash < 0) continue; // skip top-level files
    const top = path.slice(0, firstSlash);
    if (!EXAMPLE_DIR_CANDIDATES.includes(top as (typeof EXAMPLE_DIR_CANDIDATES)[number])) {
      continue;
    }
    const ext = path.split('.').pop() ?? '';
    if (!CODE_EXTENSIONS.has(ext)) continue;
    out.push(item);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, maxResults);
}

/** Locate the README entry in a tree, trying the conventional names. */
export function findReadmeInTree(
  tree: GitHubTreeItem[],
  candidates: readonly string[] = [
    'README.md',
    'readme.md',
    'Readme.md',
    'README.rst',
    'README.txt',
    'README',
  ],
): GitHubTreeItem | null {
  const byPath = new Map<string, GitHubTreeItem>();
  for (const item of tree) {
    if (item.type === 'blob') byPath.set(item.path, item);
  }
  for (const name of candidates) {
    const hit = byPath.get(name);
    if (hit) return hit;
  }
  // Fallback: case-insensitive prefix match on the top level.
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    if (!item.path.includes('/') && /^readme(\.[a-z]+)?$/i.test(item.path)) {
      return item;
    }
  }
  return null;
}

/**
 * Parse fenced code blocks from a markdown blob.
 * Returns snippets with the language declared by the info string
 * (or `'unknown'` when the fence is unmarked) and the 1-indexed
 * line numbers of the block in the source.
 */
export function extractFencedCode(markdown: string): Array<{
  code: string;
  infoString: string | null;
  startLine: number;
  endLine: number;
}> {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Array<{
    code: string;
    infoString: string | null;
    startLine: number;
    endLine: number;
  }> = [];
  let inFence = false;
  let fenceMarker = '';
  let currentInfo: string | null = null;
  let currentStart = 0;
  let buffer: string[] = [];

  const flush = (endLine: number): void => {
    if (!inFence) return;
    const code = buffer.join('\n');
    blocks.push({
      code,
      infoString: currentInfo,
      startLine: currentStart,
      endLine,
    });
    inFence = false;
    fenceMarker = '';
    currentInfo = null;
    buffer = [];
  };

  const FENCE_RE = /^(`{3,}|~{3,})\s*(.*?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1; // 1-indexed
    const m = FENCE_RE.exec(line);
    if (!inFence) {
      if (m) {
        inFence = true;
        fenceMarker = m[1][0]; // ` or ~
        currentInfo = m[2] ? m[2].split(/\s+/)[0] : null;
        currentStart = lineNo + 1; // first code line is after the fence
        buffer = [];
      }
      continue;
    }
    // We're inside a fence. Look for the closing fence: same char,
    // length >= opening, no info string.
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      const openingLen = fenceMarker.length;
      if (ch === fenceMarker && len >= openingLen && m[2].length === 0) {
        flush(lineNo - 1);
        continue;
      }
    }
    buffer.push(line);
  }
  // Unterminated fence: still emit what we have.
  if (inFence && buffer.length > 0) {
    flush(lines.length);
  }
  return blocks;
}

export interface RankedExample extends ExampleSnippet {
  /** Higher = more relevant. */
  score: number;
}

/**
 * Rank snippets by relevance to a free-text query.
 *
 * The score is a simple sum of:
 *   - TF-IDF cosine between the query tokens and the snippet tokens
 *     (re-using `lexical.tokenize` for normalisation), and
 *   - a small bonus when the query terms appear in the file path.
 *
 * Snippets with score `0` (no overlap) sink to the bottom in
 * deterministic path order so the output is reproducible.
 */
export function rankSnippets(
  snippets: ExampleSnippet[],
  query: string,
  options: { topK?: number } = {},
): RankedExample[] {
  const topK = options.topK ?? 10;
  if (snippets.length === 0) return [];

  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    // No usable tokens in the query; just return the first K in
    // path order so the caller still gets *something* deterministic.
    return snippets.slice(0, topK).map((s, i) => ({ ...s, score: 1 / (i + 1) }));
  }

  // Build per-snippet token counts once.
  const docTokens = snippets.map((s) => tokenize(s.code + ' ' + s.path));

  // Document frequency across the snippet set + the query.
  const df = new Map<string, number>();
  for (const toks of [...docTokens, Array.from(queryTokens)]) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docTokens.length + 1; // +1 for the query document
  const idf = new Map<string, number>();
  for (const [t, freq] of df) {
    idf.set(t, Math.log((N + 1) / (freq + 1)) + 1);
  }

  const scored = snippets.map((s, i) => {
    const counts = new Map<string, number>();
    for (const t of docTokens[i]) counts.set(t, (counts.get(t) ?? 0) + 1);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [t, c] of counts) {
      const w = c * (idf.get(t) ?? 0);
      normA += w * w;
      if (queryTokens.has(t)) dot += w;
    }
    for (const t of queryTokens) {
      const w = idf.get(t) ?? 0;
      normB += w * w;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const base = denom === 0 ? 0 : dot / denom;

    // Path bonus: each query token that appears in the path adds
    // a small constant. This is intentionally light (≤ 0.3) so
    // path match alone can't outrank a strong code match.
    let pathBonus = 0;
    const pathLower = s.path.toLowerCase();
    for (const t of queryTokens) {
      if (pathLower.includes(t)) pathBonus += 0.05;
    }
    return { ...s, score: Number((base + pathBonus).toFixed(6)) };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreak by path.
    return a.path.localeCompare(b.path);
  });
  return scored.slice(0, topK);
}

/**
 * Build a `ExampleSnippet` for a file in the example directory.
 * `code` is whatever the caller fetched; we attach the blob URL
 * and the language inferred from the filename.
 */
export function snippetFromFile(
  repo: GitHubRepo,
  item: GitHubTreeItem,
  code: string,
  blobUrl: (repo: GitHubRepo, path: string) => string,
  languageOf: (filename: string) => string,
): ExampleSnippet {
  return {
    code,
    path: item.path,
    url: blobUrl(repo, item.path),
    language: languageOf(item.path),
    infoString: null,
    startLine: 1,
    endLine: code.split('\n').length,
  };
}

/**
 * Build a `ExampleSnippet` for a fenced code block extracted from
 * the README. The URL includes the `#L{start}-L{end}` anchor.
 */
export function snippetFromReadme(
  repo: GitHubRepo,
  readmePath: string,
  block: { code: string; infoString: string | null; startLine: number; endLine: number },
  blobUrl: (
    repo: GitHubRepo,
    path: string,
    startLine: number,
    endLine: number,
  ) => string,
  languageOf: (infoString: string | null, filename: string) => string,
): ExampleSnippet {
  return {
    code: block.code,
    path: readmePath,
    url: blobUrl(repo, readmePath, block.startLine, block.endLine),
    language: languageOf(block.infoString, readmePath),
    infoString: block.infoString,
    startLine: block.startLine,
    endLine: block.endLine,
  };
}
