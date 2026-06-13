/**
 * TypeScript / `.d.ts` signature extraction.
 *
 * AC-6 requires `resolve_method` to pull a method's signature from
 * the package's `.d.ts` file. We use the TypeScript compiler's own
 * parser (`ts.createSourceFile`) so we get the exact same AST that
 * `tsc` would build, then walk it collecting a `dottedPath` index
 * of every method/function signature in the file.
 *
 * The walker is recursive: it maintains a "scope path" (e.g.
 * `["Stripe", "CustomersResource"]`) and on hitting a method
 * signature it records `scopePath.concat(name)` → declaration. The
 * caller looks up `methodPath` in that index.
 */
import ts from 'typescript';

export interface ExtractedParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ExtractedSignature {
  /** Literal source text of the signature (e.g. `create(params: ...): Promise<Customer>`). */
  signature: string;
  /** Parsed parameter list. */
  params: ExtractedParam[];
  /** Return type as a source string (or `""` when no return type is declared). */
  returns: string;
  /** 1-indexed source line. */
  sourceLine: number;
  /** 1-indexed source column. */
  sourceColumn: number;
  /** JSDoc summary line, if any. */
  description: string;
}

/**
 * Find a method/function signature in a `.d.ts` blob by dotted
 * path. Returns `null` when no matching declaration is present.
 *
 * Examples of `methodPath`:
 *   - "create"        → a top-level function or interface method
 *   - "customers.create" → a method on a nested resource interface
 *   - "Stripe.CustomersResource.create" → a fully-qualified lookup
 */
export function findSignatureInDts(
  content: string,
  methodPath: string,
  _filePath: string,
): ExtractedSignature | null {
  const fileName = 'snippet.d.ts';
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const index = buildIndex(sourceFile);
  // Direct lookup first.
  if (index.has(methodPath)) {
    return render(index.get(methodPath)!, sourceFile);
  }
  // Suffix match: if the caller knows only the trailing name
  // (e.g. "create") and the file has exactly one declaration
  // whose path ends with that name, use it. We also try
  // matching the full dotted suffix (e.g. "Customers.create"
  // when the caller passed "create") to be friendly to
  // namespace style declarations.
  //
  // To avoid the wrong-resource problem in SDKs that have
  // many sibling `create` methods (stripe-node has ~150 of
  // them), we require every segment of the caller's path to
  // appear in the indexed path as a full component match (not
  // as a substring). So `Customers.create` only matches
  // `...Customers...create` paths, not `...CustomerSessions...create`
  // (where "Customers" would substring-match the start of
  // "CustomerSessions").
  const segments = methodPath.toLowerCase().split('.');
  const tail = segments[segments.length - 1];
  const suffixMatches: ExtractedMatch[] = [];
  for (const [path, match] of index.entries()) {
    if (path === methodPath) continue;
    const lower = path.toLowerCase();
    if (!lower.endsWith(tail)) continue;
    if (!segments.every((seg) => componentContains(lower, seg))) continue;
    suffixMatches.push(match);
  }
  if (suffixMatches.length === 1) {
    return render(suffixMatches[0], sourceFile);
  }
  return null;
}

/** A single match in the index. */
interface ExtractedMatch {
  node: ts.SignatureDeclaration;
  line: number;
  column: number;
  description: string;
}

/** Walk the AST and build a `dottedPath → match` index. */
function buildIndex(sourceFile: ts.SourceFile): Map<string, ExtractedMatch> {
  const index = new Map<string, ExtractedMatch>();
  walk(sourceFile, [], index);
  return index;
}

function walk(
  node: ts.Node,
  scope: string[],
  index: Map<string, ExtractedMatch>,
): void {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    const name = node.name?.text;
    if (name) {
      const nextScope = scope.concat(name);
      for (const m of node.members) {
        indexMember(m, nextScope, index);
      }
      // Descend into nested type/namespace declarations.
      ts.forEachChild(node, (child) => {
        if (
          ts.isClassDeclaration(child) ||
          ts.isInterfaceDeclaration(child) ||
          ts.isModuleDeclaration(child) ||
          ts.isTypeAliasDeclaration(child) ||
          ts.isFunctionDeclaration(child)
        ) {
          walk(child, nextScope, index);
        }
      });
    }
    return;
  }

  if (ts.isModuleDeclaration(node)) {
    const name = moduleName(node.name);
    if (name) {
      const nextScope = scope.concat(name);
      const body = node.body;
      if (body && ts.isModuleBlock(body)) {
        for (const stmt of body.statements) {
          walk(stmt, nextScope, index);
        }
      } else if (body) {
        walk(body, nextScope, index);
      }
    }
    return;
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const name = node.name.text;
    const nextScope = scope.concat(name);
    if (ts.isTypeLiteralNode(node.type)) {
      for (const m of node.type.members) {
        indexMember(m, nextScope, index);
      }
    }
    return;
  }

  if (ts.isFunctionDeclaration(node) && node.name) {
    recordSignature(node, node.name.text, scope, index);
    return;
  }

  ts.forEachChild(node, (child) => walk(child, scope, index));
}

function moduleName(name: ts.ModuleName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return '';
}

function indexMember(
  m: ts.TypeElement | ts.ClassElement,
  scope: string[],
  index: Map<string, ExtractedMatch>,
): void {
  if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
    const name = memberName(m.name);
    recordSignature(m, name, scope, index);
    return;
  }
  if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
    recordSignature(m, '', scope, index);
  }
}

function memberName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (
    ts.isComputedPropertyName(name) &&
    ts.isIdentifier(name.expression)
  ) {
    return name.expression.text;
  }
  return '<computed>';
}

function recordSignature(
  decl: ts.SignatureDeclaration,
  name: string,
  scope: string[],
  index: Map<string, ExtractedMatch>,
): void {
  const path = name ? scope.concat(name).join('.') : scope.join('.');
  if (index.has(path)) return; // first declaration wins
  const sf = decl.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
  index.set(path, {
    node: decl,
    line: line + 1,
    column: character + 1,
    description: extractJsDocSummary(decl),
  });
}

function extractJsDocSummary(node: ts.Node): string {
  const tags = ts.getJSDocCommentsAndTags(node);
  for (const tag of tags) {
    if (ts.isJSDoc(tag) && tag.comment) {
      const text =
        typeof tag.comment === 'string'
          ? tag.comment
          : tag.comment.map((c) => c.text).join('');
      return text.split('\n')[0].trim();
    }
  }
  return '';
}

function render(match: ExtractedMatch, sourceFile: ts.SourceFile): ExtractedSignature {
  const decl = match.node;
  const params: ExtractedParam[] = decl.parameters.map((p) => renderParam(p));
  const returns = decl.type ? decl.type.getText(sourceFile) : '';
  // The literal signature is the original source slice.
  const sourceText = sourceFile.text
    .slice(decl.getStart(sourceFile), decl.getEnd())
    .trim();
  return {
    signature: sourceText,
    params,
    returns,
    sourceLine: match.line,
    sourceColumn: match.column,
    description: match.description,
  };
}

function renderParam(p: ts.ParameterDeclaration): ExtractedParam {
  const name = parameterName(p);
  const type = p.type ? p.type.getText() : '';
  const required = !p.questionToken && !p.initializer;
  return {
    name,
    type,
    required,
    description: extractJsDocSummary(p),
  };
}

function parameterName(p: ts.ParameterDeclaration): string {
  if (ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
    return p.name.getText();
  }
  return 'arg';
}

/**
 * Return true if `path` contains `segment` as a full component
 * (matched at the start, at the end, or surrounded by dots).
 * Used by the suffix-match fallback to prevent "Customers" from
 * substring-matching "CustomerSessions".
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

