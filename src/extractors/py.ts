/**
 * Python / `.py` / `.pyi` signature extraction.
 *
 * AC-6 requires `resolve_method` to pull a method's signature from
 * a Python package's `.py` source or `.pyi` stub. We delegate the
 * AST walk to Python itself (the `ast` module is in the stdlib
 * and there's no good JS-side equivalent), reading the source
 * from a temp file and parsing the JSON result back into the
 * TypeScript `ExtractedSignature` shape used by `ts.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractedParam, ExtractedSignature } from './ts.js';

/** Raw shape produced by the Python helper (snake_case keys). */
interface RawParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}
interface RawMatch {
  signature: string;
  params: RawParam[];
  returns: string;
  source_line: number;
  source_column: number;
  description: string;
}
interface RawResult {
  matches: Array<[string, RawMatch]>;
}

/**
 * Find a method/function signature in a Python source blob by
 * dotted path. Returns `null` when no matching declaration is
 * present.
 */
export function findSignatureInPy(
  content: string,
  methodPath: string,
  _filePath: string,
): ExtractedSignature | null {
  const result = runPythonExtractor(content, methodPath);
  if (!result) return null;

  const direct = result.matches.find(([path]) => path === methodPath);
  if (direct) return fromRaw(direct[1]);

  // Suffix match with a component-presence guard (mirrors the TS
  // extractor's logic). Without this, a caller asking for
  // `Session.get` would match `SessionRedirectMixin.get` if both
  // were declared in the same file, and in big packages the
  // trailing-segment-only fallback would be too greedy.
  const segments = methodPath.toLowerCase().split('.');
  const tail = segments[segments.length - 1];
  const suffixMatches = result.matches.filter(([path]) => {
    if (path === methodPath) return false;
    const lower = path.toLowerCase();
    if (!lower.endsWith(tail)) return false;
    return segments.every((seg) => componentContains(lower, seg));
  });
  if (suffixMatches.length === 1) return fromRaw(suffixMatches[0][1]);

  return null;
}

function fromRaw(raw: RawMatch): ExtractedSignature {
  const params: ExtractedParam[] = raw.params.map((p) => ({
    name: p.name,
    type: p.type,
    required: p.required,
    description: p.description,
  }));
  return {
    signature: raw.signature,
    params,
    returns: raw.returns,
    sourceLine: raw.source_line,
    sourceColumn: raw.source_column,
    description: raw.description,
  };
}

/**
 * Return true if `path` contains `segment` as a full component
 * (matched at the start, at the end, or surrounded by dots).
 * Mirrors the helper in `ts.ts` so both extractors have
 * matching disambiguation behaviour.
 */
function componentContains(path: string, segment: string): boolean {
  if (!segment) return true;
  let i = 0;
  while (i < path.length) {
    const at = path.indexOf(segment, i);
    if (at < 0) return false;
    const before = at === 0 ? '.' : path[at - 1];
    const after = at + segment.length >= path.length ? '.' : path[at + segment.length];
    if (before === '.' && after === '.') return true;
    i = at + 1;
  }
  return false;
}

/**
 * Run the embedded Python AST walker against `content` and parse
 * the JSON result. Returns `null` if Python is unavailable or
 * the script fails.
 */
function runPythonExtractor(content: string, methodPath: string): RawResult | null {
  const tmp = mkdtempSync(join(tmpdir(), 'docpilot-py-'));
  const sourcePath = join(tmp, 'snippet.py');
  try {
    writeFileSync(sourcePath, content, 'utf8');
    const r = spawnSync(
      'python3',
      ['-c', EXTRACTOR_SCRIPT, sourcePath, methodPath],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.status !== 0) {
      if (r.stderr) {
        // Best-effort: surface a one-line hint for the operator.
        process.stderr.write(`py-extractor: ${r.stderr.split('\n')[0]}\n`);
      }
      return null;
    }
    const json = (r.stdout ?? '').trim();
    if (!json) return null;
    try {
      return JSON.parse(json) as RawResult;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Embedded Python AST walker. Reads the source path from
 * sys.argv[1] and prints a JSON object with every def it
 * finds, scoped by class membership.
 */
const EXTRACTOR_SCRIPT = String.raw`
import ast
import json
import sys


def _annotation_to_str(node):
    if node is None:
        return ""
    try:
        return ast.unparse(node)
    except Exception:
        return ""


def _docstring_summary(node):
    body = getattr(node, "body", None)
    if not body:
        return ""
    first = body[0]
    if (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        return first.value.value.splitlines()[0].strip()
    return ""


def _signature_text(node, source_lines):
    start = node.lineno - 1
    return source_lines[start].rstrip() if 0 <= start < len(source_lines) else ""


def _param_list(args):
    """Build the JSON param list. defaults/kw_defaults live
    on the arguments container (one per parameter from the
    right), not on the arg nodes themselves, so we zip them
    carefully here.
    """
    posonly = list(getattr(args, "posonlyargs", []))
    regular = list(getattr(args, "args", []))
    # In Python 3.8+ posonlyargs + args are stored separately.
    # We treat both as positional for the purposes of "required"
    # (the only way a positional arg can be optional is via a
    # default value, which lands in args.defaults).
    positional = posonly + regular
    n_pos = len(positional)
    n_defaults = len(getattr(args, "defaults", []) or [])
    # defaults align to the *rightmost* positional args.
    default_start = n_pos - n_defaults
    out = []
    for i, a in enumerate(positional):
        has_default = i >= default_start
        out.append({
            "name": a.arg,
            "type": _annotation_to_str(a.annotation),
            "required": not has_default,
            "description": "",
        })
    if getattr(args, "vararg", None):
        a = args.vararg
        out.append({
            "name": "*" + a.arg,
            "type": _annotation_to_str(a.annotation),
            "required": False,
            "description": "",
        })
    kwonly = list(getattr(args, "kwonlyargs", []))
    kw_defaults = list(getattr(args, "kw_defaults", []) or [])
    for i, a in enumerate(kwonly):
        has_default = kw_defaults[i] is not None
        out.append({
            "name": a.arg,
            "type": _annotation_to_str(a.annotation),
            "required": not has_default,
            "description": "",
        })
    if getattr(args, "kwarg", None):
        a = args.kwarg
        out.append({
            "name": "**" + a.arg,
            "type": _annotation_to_str(a.annotation),
            "required": False,
            "description": "",
        })
    return out


def _collect(source_path):
    with open(source_path, "r", encoding="utf-8") as fh:
        text = fh.read()
    source_lines = text.splitlines()
    tree = ast.parse(text, filename=source_path)
    matches = []

    def walk(node, scope):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                path = ".".join(scope + [child.name])
                ret = _annotation_to_str(child.returns)
                matches.append([
                    path,
                    {
                        "signature": _signature_text(child, source_lines),
                        "params": _param_list(child.args),
                        "returns": ret,
                        "source_line": child.lineno,
                        "source_column": child.col_offset + 1,
                        "description": _docstring_summary(child),
                    },
                ])
                if isinstance(child, ast.ClassDef):
                    walk(child, scope + [child.name])
                elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    walk(child, scope + [child.name])
            elif isinstance(child, ast.ClassDef):
                walk(child, scope + [child.name])
            else:
                walk(child, scope)

    walk(tree, [])
    return matches


def main():
    source_path = sys.argv[1]
    matches = _collect(source_path)
    json.dump({"matches": matches}, sys.stdout)


main()
`;
