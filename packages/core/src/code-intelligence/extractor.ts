import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type * as TypeScript from 'typescript'
import {
  type CodeGraphExtractor,
  type CodeGraphFileShard,
  type CodeGraphLocation,
  type CodeSymbolKind,
} from './models'

export async function createTypeScriptCodeGraphExtractor(): Promise<CodeGraphExtractor> {
  const ts = await import('typescript')
  return {
    async extract(input) {
      return extractTypeScriptShard(ts, input)
    },
  }
}

function extractTypeScriptShard(
  ts: typeof TypeScript,
  input: Parameters<CodeGraphExtractor['extract']>[0],
): CodeGraphFileShard {
  const sourceFile = ts.createSourceFile(
    input.relativePath,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, input.relativePath),
  )
  const definitions: CodeGraphLocation[] = []
  const references: CodeGraphLocation[] = []
  const occurrences: CodeGraphLocation[] = []
  const seen = new Set<string>()

  const visit = (node: TypeScript.Node): void => {
    if (ts.isIdentifier(node)) {
      const definitionKind = definitionKindForIdentifier(ts, node)
      const location = locationForIdentifier(
        sourceFile,
        node,
        input.relativePath,
        definitionKind ?? 'reference',
      )
      const key = locationKey(location)
      if (!seen.has(key)) {
        seen.add(key)
        occurrences.push(location)
        if (definitionKind) definitions.push(location)
        else references.push(location)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return freezeShard({
    path: input.relativePath,
    bytes: input.bytes,
    mtimeMs: input.mtimeMs,
    contentSha256: createHash('sha256')
      .update(input.content, 'utf8')
      .digest('hex'),
    definitions: stableLocations(definitions),
    references: stableLocations(references),
    occurrences: stableLocations(occurrences),
  })
}

function definitionKindForIdentifier(
  ts: typeof TypeScript,
  node: TypeScript.Identifier,
): CodeSymbolKind | null {
  const parent = node.parent
  if (!parent || !('name' in parent) || parent.name !== node) return null
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent))
    return 'function'
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
    return 'class'
  if (ts.isInterfaceDeclaration(parent)) return 'interface'
  if (
    ts.isTypeAliasDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent)
  )
    return 'type'
  if (ts.isEnumDeclaration(parent) || ts.isEnumMember(parent)) return 'enum'
  if (ts.isModuleDeclaration(parent)) return 'module'
  if (
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent)
  )
    return 'method'
  if (
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent)
  )
    return 'property'
  if (ts.isParameter(parent)) return 'parameter'
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  )
    return 'import'
  if (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent))
    return 'variable'
  return null
}

function locationForIdentifier(
  sourceFile: TypeScript.SourceFile,
  node: TypeScript.Identifier,
  path: string,
  kind: CodeSymbolKind,
): CodeGraphLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  )
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())
  return Object.freeze({
    symbol: node.text,
    path,
    line: start.line + 1,
    column: start.character + 1,
    endColumn:
      end.line === start.line
        ? Math.max(start.character + 1, end.character)
        : start.character + node.text.length,
    kind,
  })
}

function stableLocations(
  locations: readonly CodeGraphLocation[],
): readonly CodeGraphLocation[] {
  return Object.freeze(
    [...locations].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.column - right.column ||
        left.symbol.localeCompare(right.symbol) ||
        left.kind.localeCompare(right.kind),
    ),
  )
}

function freezeShard(shard: CodeGraphFileShard): CodeGraphFileShard {
  return Object.freeze(shard)
}

function locationKey(location: CodeGraphLocation): string {
  return [
    location.symbol,
    location.path,
    location.line,
    location.column,
    location.kind,
  ].join('\0')
}

function scriptKind(
  ts: typeof TypeScript,
  path: string,
): TypeScript.ScriptKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}
