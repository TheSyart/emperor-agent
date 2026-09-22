import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Core production import graph', () => {
  it('contains no runtime or type-only cycles', () => {
    const graphs = buildImportGraphs(SRC_ROOT)

    expect(cyclesIn(graphs.runtime).map(formatCycle)).toEqual([])
    // The harness kernel's collaborators (middleware, prompt assembler, tool
    // registry/definitions) take the `Agent` class as a type, and agent.ts
    // composes them at runtime. That type-only strongly connected component
    // around harness/agent/agent.ts is by design; every other type cycle fails.
    expect(
      cyclesIn(graphs.all)
        .map(formatCycle)
        .filter((cycle) => !isHarnessAgentTypeCycle(cycle)),
    ).toEqual([])
  })
})

function isHarnessAgentTypeCycle(cycle: string[]): boolean {
  return (
    cycle.includes('harness/agent/agent.ts') &&
    cycle.every((file) => file.startsWith('harness/'))
  )
}

interface ImportGraphs {
  runtime: Map<string, Set<string>>
  all: Map<string, Set<string>>
}

function buildImportGraphs(root: string): ImportGraphs {
  const files = productionTypeScriptFiles(root)
  const known = new Set(files)
  const runtime = new Map(files.map((file) => [file, new Set<string>()]))
  const all = new Map(files.map((file) => [file, new Set<string>()]))

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const add = (specifier: string, isRuntime: boolean): void => {
      const target = resolveRelativeModule(file, specifier, known)
      if (!target) return
      all.get(file)!.add(target)
      if (isRuntime) runtime.get(file)!.add(target)
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text, importDeclarationIsRuntime(node))
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text, exportDeclarationIsRuntime(node))
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        add(node.arguments[0]!.text, true)
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        add(node.argument.literal.text, false)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { runtime, all }
}

function importDeclarationIsRuntime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some((element) => !element.isTypeOnly)
}

function exportDeclarationIsRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

function resolveRelativeModule(
  importer: string,
  specifier: string,
  known: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(importer), specifier)
  const candidates = extname(base)
    ? [base]
    : [`${base}.ts`, resolve(base, 'index.ts')]
  return candidates.find((candidate) => known.has(candidate)) ?? null
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(path)
      }
    }
  }
  if (statSync(root).isDirectory()) walk(root)
  return files.sort()
}

function cyclesIn(graph: Map<string, Set<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []

  const connect = (node: string): void => {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (
      component.length > 1 ||
      (component.length === 1 && graph.get(node)?.has(node))
    ) {
      cycles.push(component.sort())
    }
  }

  for (const node of graph.keys()) if (!indices.has(node)) connect(node)
  return cycles.sort((left, right) => left[0]!.localeCompare(right[0]!))
}

function formatCycle(files: string[]): string[] {
  return files.map((file) => relative(SRC_ROOT, file))
}
