/**
 * Small, dependency-free helpers shared by the collector modules.
 * Keeping the helpers here makes the pure evaluation layer easy to test
 * without a running source.
 */

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export function toFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function toPositiveInteger(value, fallback = null) {
  const number = toFiniteNumber(value, fallback)
  return number !== null && Number.isInteger(number) && number > 0 ? number : fallback
}

export function nonNegativeInteger(value, fallback = 0) {
  const number = toFiniteNumber(value, fallback)
  return number !== null && Number.isInteger(number) && number >= 0 ? number : fallback
}

export function unique(values) {
  return [...new Set(values)]
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

export function ceilDiv(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return Math.ceil(numerator / denominator)
}

export function floorDiv(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return Math.floor(numerator / denominator)
}

export function roundQuantity(value, precision = 6) {
  if (!Number.isFinite(value)) return value
  const scale = 10 ** precision
  return Math.round((value + Number.EPSILON) * scale) / scale
}

export function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
}

export function key(...parts) {
  return parts.map(part => String(part ?? '')).join('|')
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map(name =>
    JSON.stringify(name) + ':' + stableStringify(value[name])).join(',') + '}'
}

export function describeError(error) {
  if (!error) return '未知错误'
  if (error instanceof Error) return error.message
  return String(error)
}

export function nowIso(clock = () => new Date()) {
  const value = typeof clock === 'function' ? clock() : clock
  return value instanceof Date ? value.toISOString() : String(value)
}
