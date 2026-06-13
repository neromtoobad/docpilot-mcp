/**
 * Syntax validation for the `code` field of `search_examples` results.
 *
 * AC-5 requires each returned `code` block to parse as valid syntax
 * for its declared `language`. The plan's verification matrix pins
 * the validators to:
 *
 *   - `node --check` for `.js` / `.cjs` / `.mjs` (we use the
 *     TypeScript compiler's parser for `.ts` because `node` does
 *     not understand TypeScript syntax out of the box),
 *   - `python3 -c "import ast; ast.parse(<code>)"` for `.py`.
 *
 * Each public function returns `true` for valid syntax and `false`
 * otherwise — they never throw on a syntax error (they only throw
 * when the toolchain itself is missing or broken, e.g. no `node` on
 * PATH, which is a server-side misconfiguration).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';

/** Languages we know how to validate. */
export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'shell'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'unknown';

/**
 * Normalise the fenced info string or file extension into one of the
 * `SupportedLanguage` tags. Returns `'unknown'` for anything we don't
 * have a validator for.
 */
export function detectLanguage(
  infoString: string | null | undefined,
  filename: string | null | undefined,
): SupportedLanguage {
  const info = (infoString ?? '').trim().toLowerCase();
  const fname = (filename ?? '').toLowerCase();
  const ext = fname.includes('.') ? fname.split('.').pop() ?? '' : '';
  if (
    info === 'js' ||
    info === 'javascript' ||
    info === 'jsx' ||
    ext === 'js' ||
    ext === 'cjs' ||
    ext === 'mjs' ||
    ext === 'jsx'
  ) {
    return 'javascript';
  }
  if (
    info === 'ts' ||
    info === 'typescript' ||
    info === 'tsx' ||
    ext === 'ts' ||
    ext === 'tsx'
  ) {
    return 'typescript';
  }
  if (info === 'py' || info === 'python' || ext === 'py') {
    return 'python';
  }
  if (info === 'sh' || info === 'bash' || info === 'shell' || ext === 'sh' || ext === 'bash') {
    return 'shell';
  }
  if (info === 'rb' || info === 'ruby' || ext === 'rb') {
    return 'ruby';
  }
  if (info === 'go' || ext === 'go') return 'go';
  if (info === 'rs' || info === 'rust' || ext === 'rs') return 'rust';
  return 'unknown';
}

/**
 * Write `code` to a tmp file with the right extension and run
 * `node --check` against it. Returns `true` on success.
 */
function nodeCheck(code: string, ext: '.js' | '.cjs' | '.mjs'): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'docpilot-syntax-'));
  const path = join(dir, `snippet${ext}`);
  try {
    writeFileSync(path, code, 'utf8');
    const r = spawnSync(process.execPath, ['--check', path], {
      encoding: 'utf8',
    });
    return r.status === 0;
  } catch {
    return false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Validate a JS / `.cjs` / `.mjs` snippet by running `node --check`
 * against a temp file. We choose the extension based on the
 * filename so import/export are accepted in the right place.
 */
export function isValidJavaScript(code: string, filename: string): boolean {
  if (filename.endsWith('.mjs')) return nodeCheck(code, '.mjs');
  if (filename.endsWith('.cjs')) return nodeCheck(code, '.cjs');
  return nodeCheck(code, '.js');
}

/**
 * Validate a TypeScript snippet by running it through TypeScript's
 * transpile pipeline with `reportDiagnostics: true`. Any reported
 * syntax error makes the snippet invalid.
 *
 * The plan calls for `node --check` for `.ts` too, but `node` does
 * not understand TypeScript syntax. We use the TS compiler API,
 * which is the standard way to do "syntax only" checks in the
 * TypeScript ecosystem (e.g. ESLint's `@typescript-eslint/parser`
 * uses the same machinery under the hood).
 */
export function isValidTypeScript(code: string, filename: string): boolean {
  const isTsx = filename.endsWith('.tsx');
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      filename: isTsx ? 'snippet.tsx' : 'snippet.ts',
      reportDiagnostics: true,
    },
    reportDiagnostics: true,
  });
  if (!result.diagnostics || result.diagnostics.length === 0) return true;
  // `transpileModule` only surfaces parse-time errors (the
  // type-checker is not invoked), so every diagnostic here is a
  // syntax error.
  return result.diagnostics.every(
    (d) => d.category !== ts.DiagnosticCategory.Error,
  );
}

/**
 * Validate a Python snippet by spawning `python3 -c "<ast.parse>"`
 * with the code piped on stdin. The wrapper script reads stdin and
 * exits 0 on a clean parse, 1 on a `SyntaxError`.
 */
export function isValidPython(code: string): boolean {
  const program =
    'import ast, sys\n' +
    'try:\n' +
    '    ast.parse(sys.stdin.read())\n' +
    'except SyntaxError:\n' +
    '    sys.exit(1)\n';
  const r = spawnSync('python3', ['-c', program], {
    encoding: 'utf8',
    input: code,
  });
  return r.status === 0;
}

/**
 * Public entry point. Returns `true` if the snippet is valid syntax
 * for `language`. Returns `true` for `'unknown'` and non-supported
 * languages (we don't have a parser for them, so we accept them).
 */
export function isValidSyntax(
  code: string,
  language: SupportedLanguage,
  filename?: string,
): boolean {
  if (code.trim().length === 0) return true;
  switch (language) {
    case 'javascript':
      return isValidJavaScript(code, filename ?? 'snippet.js');
    case 'typescript':
      return isValidTypeScript(code, filename ?? 'snippet.ts');
    case 'python':
      return isValidPython(code);
    // No external validators for these in v0.1; accept them.
    case 'shell':
    case 'ruby':
    case 'go':
    case 'rust':
    case 'unknown':
      return true;
  }
}
