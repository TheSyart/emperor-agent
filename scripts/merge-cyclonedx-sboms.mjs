#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [corePath, desktopPath, outputPath] = process.argv.slice(2)
if (!corePath || !desktopPath || !outputPath) {
  throw new Error(
    'usage: merge-cyclonedx-sboms.mjs <core-bom> <desktop-bom> <output>',
  )
}

const coreBom = readBom(corePath)
const desktopBom = readBom(desktopPath)
const corePackage = readJson(`${repoRoot}/packages/core/package.json`)
const desktopPackage = readJson(`${repoRoot}/desktop/package.json`)

assertDeclaredDependencies(coreBom, corePackage, new Set())
assertDeclaredDependencies(
  desktopBom,
  desktopPackage,
  new Set(['@emperor/core']),
)
assertComponent(desktopBom, '@emperor/core')

const coreComponent = findComponent(coreBom, '@emperor/core')
const desktopCoreComponent = findComponent(desktopBom, '@emperor/core')
const reachableCoreRefs = reachableReferences(coreBom, coreComponent['bom-ref'])
const canonicalComponents = new Map()
const referenceMap = new Map()

for (const component of desktopBom.components || []) {
  addComponent(component, canonicalComponents, referenceMap)
}
for (const component of coreBom.components || []) {
  if (
    component['bom-ref'] !== coreComponent['bom-ref'] &&
    containsReachableReference(component, reachableCoreRefs)
  ) {
    addComponent(component, canonicalComponents, referenceMap)
  }
}
referenceMap.set(coreComponent['bom-ref'], desktopCoreComponent['bom-ref'])

const dependencies = new Map()
mergeDependencies(
  desktopBom.dependencies || [],
  null,
  referenceMap,
  dependencies,
)
mergeDependencies(
  coreBom.dependencies || [],
  reachableCoreRefs,
  referenceMap,
  dependencies,
)

const merged = {
  ...desktopBom,
  serialNumber: undefined,
  metadata: {
    ...desktopBom.metadata,
    timestamp: undefined,
    properties: [
      ...(desktopBom.metadata?.properties || []),
      {
        name: 'emperor:sbom:desktop-lock-sha256',
        value: sha256(`${repoRoot}/desktop/package-lock.json`),
      },
      {
        name: 'emperor:sbom:core-lock-sha256',
        value: sha256(`${repoRoot}/package-lock.json`),
      },
    ].sort((left, right) => left.name.localeCompare(right.name)),
  },
  components: [...canonicalComponents.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  ),
  dependencies: [...dependencies.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((left, right) => left.ref.localeCompare(right.ref)),
}

validateReferences(merged)
writeFileSync(outputPath, `${JSON.stringify(merged, jsonReplacer, 2)}\n`)
console.log(`merged CycloneDX SBOM with ${merged.components.length} components`)

function readBom(path) {
  const bom = readJson(path)
  if (
    bom.bomFormat !== 'CycloneDX' ||
    bom.specVersion !== '1.6' ||
    !Array.isArray(bom.components) ||
    !Array.isArray(bom.dependencies)
  ) {
    throw new Error(`invalid CycloneDX 1.6 input: ${path}`)
  }
  return bom
}

function assertDeclaredDependencies(bom, manifest, ignored) {
  const names = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ])
  for (const name of names) {
    if (!ignored.has(name)) assertComponent(bom, name)
  }
}

function assertComponent(bom, packageName) {
  findComponent(bom, packageName)
}

function findComponent(bom, packageName) {
  const [group, name] = splitPackageName(packageName)
  const component = (bom.components || []).find(
    (candidate) => (candidate.group || '') === group && candidate.name === name,
  )
  if (!component)
    throw new Error(`SBOM is missing declared dependency: ${packageName}`)
  return component
}

function splitPackageName(packageName) {
  if (!packageName.startsWith('@')) return ['', packageName]
  const slash = packageName.indexOf('/')
  return [packageName.slice(0, slash), packageName.slice(slash + 1)]
}

function reachableReferences(bom, rootRef) {
  const graph = new Map(
    bom.dependencies.map((item) => [item.ref, item.dependsOn || []]),
  )
  const reached = new Set()
  const pending = [rootRef]
  while (pending.length) {
    const ref = pending.pop()
    if (!ref || reached.has(ref)) continue
    reached.add(ref)
    pending.push(...(graph.get(ref) || []))
  }
  return reached
}

function addComponent(component, components, references) {
  if (components.has(component['bom-ref'])) {
    throw new Error(`duplicate SBOM reference: ${component['bom-ref']}`)
  }
  components.set(component['bom-ref'], component)
  const register = (candidate) => {
    references.set(candidate['bom-ref'], candidate['bom-ref'])
    for (const nested of candidate.components || []) register(nested)
  }
  register(component)
}

function containsReachableReference(component, reachable) {
  if (reachable.has(component['bom-ref'])) return true
  return (component.components || []).some((nested) =>
    containsReachableReference(nested, reachable),
  )
}

function mergeDependencies(items, allowedRefs, references, output) {
  for (const item of items) {
    if (allowedRefs && !allowedRefs.has(item.ref)) continue
    const ref = references.get(item.ref) || item.ref
    const targets = output.get(ref) || new Set()
    for (const dependency of item.dependsOn || []) {
      if (!allowedRefs || allowedRefs.has(dependency)) {
        targets.add(references.get(dependency) || dependency)
      }
    }
    output.set(ref, targets)
  }
}

function validateReferences(bom) {
  const refs = new Set([bom.metadata.component['bom-ref']])
  const collect = (component) => {
    if (component['bom-ref']) refs.add(component['bom-ref'])
    for (const nested of component.components || []) collect(nested)
  }
  for (const component of bom.components) collect(component)
  for (const dependency of bom.dependencies) {
    if (!refs.has(dependency.ref)) {
      throw new Error(`SBOM dependency has unknown ref: ${dependency.ref}`)
    }
    for (const target of dependency.dependsOn) {
      if (!refs.has(target)) {
        throw new Error(`SBOM dependency target has unknown ref: ${target}`)
      }
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function jsonReplacer(_key, value) {
  return value === undefined ? undefined : value
}
