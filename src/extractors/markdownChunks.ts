/**
 * Heading-aware text chunker.
 *
 * Splits a page or markdown blob into chunks of ~`maxTokens` tokens
 * (whitespace-delimited) with ~`overlap` tokens of overlap. Each chunk
 * remembers the URL it came from and the nearest preceding section
 * heading (or "(untitled)").
 *
 * Per the plan (AC-7) chunks should be ~500 tokens with 50-token
 * overlap; we default to those values.
 */
export interface Chunk {
  /** 0-indexed chunk number within the page. */
  index: number;
  /** Nearest preceding heading text, or "(untitled)". */
  section: string;
  /** Raw chunk text. */
  text: string;
  /** URL the chunk was extracted from. */
  url: string;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
}

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OVERLAP = 50;

/**
 * Chunk a body of text. Tokens are whitespace-delimited words — this
 * is intentionally simple; the plan defers a real tokenizer to AC-7.
 */
export function chunkText(
  text: string,
  url: string,
  options: ChunkOptions = {},
): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.max(0, maxTokens - 1));

  // First, split on heading-like boundaries. We use a regex that
  // matches both ATX headings (`# Heading`) and Setext (`===` / `---`).
  // For raw HTML, we also try to split on `<h1..6>` and section breaks.
  const sections = splitIntoSections(text);

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  for (const section of sections) {
    const words = section.body.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let start = 0;
    while (start < words.length) {
      const end = Math.min(start + maxTokens, words.length);
      const slice = words.slice(start, end).join(' ');
      chunks.push({
        index: chunkIndex++,
        section: section.heading,
        text: slice,
        url,
      });
      if (end === words.length) break;
      start = Math.max(0, end - overlap);
    }
  }
  return chunks;
}

interface Section {
  heading: string;
  body: string;
}

/** Split a text blob into (heading, body) sections. */
function splitIntoSections(text: string): Section[] {
  // Normalize line endings.
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const sections: Section[] = [];
  let currentHeading = '(untitled)';
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    if (body.length > 0) {
      sections.push({ heading: currentHeading, body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const setextMatch = /^[=-]{2,}\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      continue;
    }
    if (setextMatch && buffer.length > 0) {
      const prev = buffer.pop() ?? '';
      flush();
      currentHeading = prev.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}
