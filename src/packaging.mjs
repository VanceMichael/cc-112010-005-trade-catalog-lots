/**
 * Packaging trees.
 *
 * A wholesale product describes packaging as a tree of containment edges:
 *   { id: 'pallet', child: 'box', n: 8 }
 *   { id: 'kit', child: 'part', n: 3, splittable: false }
 *
 * `n` is how many `child` units one `id` unit contains.  The buyer states a
 * requirement in kits, while quotes and warehouse reservations use their own
 * sale/stock unit.  Every quantity below is converted to kits unless the
 * caller explicitly asks for another base unit.
 *
 * `splittable: false` is deliberately strict: the edge may not be opened, so
 * a unit below that edge is not individually sellable (a kit with three
 * non-splittable parts is one atomic multipack).
 */

import { normalizeUnit } from './units.mjs'
import { roundQuantity, stableStringify, toFiniteNumber } from './util.mjs'

const MAX_PATHS = 32
const MAX_DEPTH = 32

function normalizeEdge(entry) {
  if (!entry || typeof entry !== 'object') return null
  const parent = normalizeUnit(entry.id)
  const child = normalizeUnit(entry.child)
  const n = toFiniteNumber(entry.n)
  if (!parent || !child || n === null || n <= 0) return null
  return {
    parent,
    child,
    n,
    // null means "not stated"; only an explicit false forbids splitting.
    splittable: entry.splittable === undefined ? null : entry.splittable !== false
  }
}

export function normalizeTree(tree) {
  const edges = []
  const seen = new Set()
  for (const entry of Array.isArray(tree) ? tree : []) {
    const edge = normalizeEdge(entry)
    if (!edge) continue
    const fingerprint = edge.parent + '>' + edge.child + ':' + edge.n + ':' + edge.splittable
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    edges.push(edge)
  }
  return edges
}

function treeFingerprint(edges) {
  return stableStringify(edges
    .map(edge => [edge.parent, edge.child, edge.n, edge.splittable])
    .sort((left, right) => left.join('|').localeCompare(right.join('|'))))
}

/**
 * Build a conversion model for one packaging tree.
 * The model is intentionally immutable and serialisable.
 */
export function buildPackageModel(tree, attributes = {}) {
  const edges = normalizeTree(tree)
  const nodes = new Set()
  const adjacency = new Map()
  const add = (from, entry) => {
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from).push(entry)
  }
  for (const edge of edges) {
    nodes.add(edge.parent)
    nodes.add(edge.child)
    add(edge.parent, { next: edge.child, multiply: edge.n, direction: 'down', edge })
    add(edge.child, { next: edge.parent, multiply: 1 / edge.n, direction: 'up', edge })
  }

  const findPaths = (from, to) => {
    if (!nodes.has(from) || !nodes.has(to)) return []
    if (from === to) return [{ factor: 1, steps: [] }]
    const results = []
    const visit = (node, factor, steps, seen) => {
      if (results.length >= MAX_PATHS || steps.length >= MAX_DEPTH) return
      for (const step of adjacency.get(node) ?? []) {
        if (seen.has(step.next)) continue
        const nextSteps = [...steps, step]
        const nextFactor = factor * step.multiply
        if (step.next === to) {
          results.push({ factor: nextFactor, steps: nextSteps })
          if (results.length >= MAX_PATHS) return
          continue
        }
        if (nextSteps.length < MAX_DEPTH) {
          visit(step.next, nextFactor, nextSteps, new Set([...seen, step.next]))
        }
      }
    }
    visit(from, 1, [], new Set([from]))
    return results
  }

  const factors = (from, to) => findPaths(from, to).map(path => path.factor)

  /** Unit is a descendant that can only be reached by opening a sealed edge. */
  const sealedContainersFor = (unit) => {
    const sealed = []
    for (const edge of edges) {
      if (edge.splittable !== false) continue
      const stack = [edge.child]
      const seen = new Set()
      while (stack.length) {
        const current = stack.pop()
        if (seen.has(current)) continue
        seen.add(current)
        if (current === unit) {
          sealed.push(edge)
          break
        }
        for (const step of adjacency.get(current) ?? []) {
          if (step.direction === 'down') stack.push(step.next)
        }
      }
    }
    return sealed
  }

  const isSellable = (unit) => nodes.has(unit) && sealedContainersFor(unit).length === 0

  const factorTo = (from, to) => {
    const values = factors(from, to)
    if (!values.length) return null
    const uniqueValues = [...new Set(values)]
    return uniqueValues.length === 1 ? uniqueValues[0] : null
  }

  const splitBlocked = (from, to) => {
    const paths = findPaths(from, to)
    if (!paths.length) return null
    // Opening a package means walking down an edge.  Combining smaller units
    // into a larger one does not require opening anything.
    const usable = paths.filter(path => path.steps.every(step =>
      step.direction !== 'down' || step.edge.splittable !== false))
    const blocked = paths.filter(path => !usable.includes(path))
    return {
      paths: paths.length,
      usable: usable.length,
      blocked: blocked.length,
      blockedEdges: [...new Set(blocked.flatMap(path => path.steps
        .filter(step => step.direction === 'down' && step.edge.splittable === false)
        .map(step => step.edge.parent + '>' + step.edge.child)))]
    }
  }

  const convert = (quantity, from, to) => {
    const value = toFiniteNumber(quantity)
    if (value === null) return { ok: false, reason: '数量不是有效数字', quantity: null }
    if (!nodes.has(from) || !nodes.has(to)) {
      return { ok: false, reason: `包装图中没有 ${from} 或 ${to}`, quantity: null }
    }
    const factor = factorTo(from, to)
    if (factor === null) {
      return { ok: false, reason: `包装图中 ${from} 与 ${to} 之间的换算不唯一`, quantity: null }
    }
    const split = splitBlocked(from, to)
    if (!split.usable) {
      return {
        ok: false,
        reason: `不可拆售包装：${from} 不能拆到 ${to}`,
        blockedEdges: split.blockedEdges,
        quantity: null
      }
    }
    return { ok: true, quantity: roundQuantity(value * factor), factor, unit: to }
  }

  const unitInfo = (unit) => {
    if (!nodes.has(unit)) return { unit, known: false, sellable: false, kitsPerUnit: null }
    const kitsPerUnit = factorTo(unit, 'kit')
    return {
      unit,
      known: true,
      sellable: isSellable(unit),
      kitsPerUnit,
      sealedContainers: sealedContainersFor(unit).map(edge => edge.parent + '>' + edge.child)
    }
  }

  return {
    ...attributes,
    tree: edges,
    fingerprint: treeFingerprint(edges),
    nodes: [...nodes],
    edges,
    factors: Object.fromEntries([...nodes].map(unit => [unit, factorTo(unit, 'kit')])),
    units: Object.fromEntries([...nodes].map(unit => [unit, unitInfo(unit)])),
    sealedEdges: edges.filter(edge => edge.splittable === false)
      .map(edge => ({ parent: edge.parent, child: edge.child, n: edge.n })),
    factorTo,
    convert,
    isSellable,
    unitInfo,
    splitBlocked
  }
}

export function packagesHaveSameTree(left, right) {
  return left?.fingerprint !== undefined && left.fingerprint === right?.fingerprint
}
