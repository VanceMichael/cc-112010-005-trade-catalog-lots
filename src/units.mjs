/**
 * Unit vocabulary.  The sources use a handful of package units; normalise
 * spelling and common Chinese labels so that trees, quotes and reservations
 * can be compared.  Conversion itself always comes from a packaging tree –
 * this module never assumes a fixed number of boxes per pallet.
 */

const ALIASES = new Map([
  ['pallet', 'pallet'],
  ['托', 'pallet'],
  ['托盘', 'pallet'],
  ['栈板', 'pallet'],
  ['box', 'box'],
  ['carton', 'box'],
  ['盒', 'box'],
  ['箱', 'box'],
  ['kit', 'kit'],
  ['component', 'kit'],
  ['组件', 'kit'],
  ['套件', 'kit'],
  ['part', 'part'],
  ['piece', 'part'],
  ['零件', 'part'],
  ['配件', 'part'],
  ['set', 'set'],
  ['multipack', 'set'],
  ['套装', 'set'],
  ['多件套', 'set']
])

export const KIT = 'kit'

export function normalizeUnit(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  return ALIASES.get(text.toLowerCase()) ?? text.toLowerCase()
}

export function isKitUnit(value) {
  return normalizeUnit(value) === KIT
}

/**
 * Interprets a buyer quantity.  Buyers normally state a number of kits; a
 * different unit is only usable when the packaging model can convert it and
 * the unit is genuinely sellable (not sealed inside an atomic multipack).
 */
export function requestedKits(quantity, unit, packaging) {
  const amount = Number(quantity)
  if (!Number.isFinite(amount)) return { ok: false, kits: null, reason: '数量不是有效数字' }
  const from = normalizeUnit(unit ?? KIT)
  if (from === KIT) return { ok: true, kits: amount, unit: KIT }
  if (!packaging) return { ok: false, kits: null, reason: `需求单位 ${from} 缺少包装资料` }
  const info = packaging.unitInfo(from)
  if (!info.known) return { ok: false, kits: null, reason: `包装图中没有 ${from}` }
  if (!info.sellable) {
    return { ok: false, kits: null, reason: `需求单位 ${from} 属于不可拆售包装，不能单独计量` }
  }
  const converted = packaging.convert(amount, from, KIT)
  if (!converted.ok) return { ok: false, kits: null, reason: converted.reason }
  return { ok: true, kits: converted.quantity, unit: from }
}
