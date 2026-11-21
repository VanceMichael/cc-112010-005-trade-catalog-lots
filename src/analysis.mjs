/**
 * Availability analysis.
 *
 * Two different questions are answered here:
 *
 *   confirmed inquiry – what did the warehouse actually commit to *this*
 *     inquiry?  Its original sale unit, quote and allocated positions remain
 *     authoritative.  New-batch stock is only ever counted through a
 *     confirmed receipt belonging to this inquiry that replaces an earlier
 *     receipt (`replacesReceipt`).
 *
 *   unconfirmed inquiry – re-price against the market's current option and
 *     the stock this delivery can actually use.  Whole sale units are
 *     mandatory: the amount shipped is the requested kit count rounded up to
 *     the quote's sale unit, capped by capacity and by the quote maximum.
 *     When that rounded amount is larger than requested, the excess is
 *     reported for the buyer to accept.  When the new packaging minimum, the
 *     new market quote, or the stock is insufficient, the deliverable old
 *     share and the remaining gap are reported separately.
 *
 * Capacity is pool based.  A physical pool is counted once; confirmed
 * reservations subtract from it, and unconfirmed inquiries draw on what is
 * left in a deterministic, documented order (the order the source lists the
 * inquiries).  This planning allocation is evidence, not a warehouse
 * confirmation, and is labelled as such.  Options are never consolidated just
 * because their lot numbers happen to match.
 */

import {
  KIT,
  normalizeUnit,
  optionCandidatesFor,
  optionForLot,
  poolsFor,
  summarizePool
} from './model.mjs'
import {
  asArray,
  ceilDiv,
  floorDiv,
  key,
  roundQuantity,
  sum,
  toFiniteNumber
} from './util.mjs'

function quoteMapKey(market, lot, quantity) {
  return key(market, lot, quantity)
}

export function normalizeQuote(record, packaging) {
  if (!record) return { state: 'missing', reason: '没有报价记录' }
  if (record.state !== 'published') {
    return {
      state: record.state ?? 'pending',
      status: record.status ?? 0,
      reason: record.error ?? record.reason ?? '该市场与批号的交货报价尚未公布',
      observedEarlier: record.observedEarlier === true,
      raw: record.body ?? null
    }
  }
  const body = record.body && typeof record.body === 'object' ? record.body : {}
  const saleUnit = body.saleUnit ? normalizeUnit(body.saleUnit) : null
  const factor = packaging && saleUnit ? packaging.factorTo(saleUnit, KIT) : null
  // A unit below a `splittable: false` edge is one atomic multipack and may
  // not be sold on its own, even though it can be converted mathematically.
  const unitInfo = packaging && saleUnit ? packaging.unitInfo(saleUnit) : null
  const sellable = unitInfo ? unitInfo.sellable : false
  const minimum = toFiniteNumber(body.min)
  const maximum = toFiniteNumber(body.maximum)
  const convertible = saleUnit !== null && factor !== null && sellable
  let reason = null
  if (!saleUnit) reason = '报价缺少销售单位'
  else if (factor === null) reason = `报价销售单位 ${saleUnit} 不在该包装资料中`
  else if (!sellable) reason = `销售单位 ${saleUnit} 属于不可拆售包装，不能单独报价`
  return {
    state: 'published',
    status: record.status ?? 200,
    id: body.id ? String(body.id) : null,
    saleUnit,
    saleUnitKits: factor,
    min: minimum,
    maximum,
    minKits: minimum === null || factor === null ? null : roundQuantity(minimum * factor),
    maxKits: maximum === null || factor === null ? null : roundQuantity(maximum * factor),
    price: toFiniteNumber(body.price),
    currency: body.currency ?? null,
    delivery: body.delivery ?? null,
    convertible,
    sellable,
    observedEarlier: record.observedEarlier === true,
    reason,
    raw: body
  }
}

export function planQuoteRequests(catalog, inquiries = catalog.inquiries) {
  const requests = new Map()
  const add = (market, lot, quantity) => {
    if (!market || !lot || !Number.isFinite(quantity) || quantity <= 0) return
    const id = quoteMapKey(market, lot, quantity)
    if (!requests.has(id)) requests.set(id, { market, lot, quantity, key: id })
  }
  for (const inquiry of asArray(inquiries)) {
    if (!inquiry.market || !Number.isFinite(inquiry.requiredKits)) continue
    for (const option of optionCandidatesFor(catalog, inquiry)) {
      add(option.market, option.lot, inquiry.requiredKits)
    }
    if (inquiry.original?.market && inquiry.original?.lot) {
      add(inquiry.original.market, inquiry.original.lot, inquiry.requiredKits)
    }
    for (const row of catalog.lots) {
      if (row.market !== inquiry.market || !row.replacement?.old) continue
      add(inquiry.market, row.replacement.old, inquiry.requiredKits)
    }
  }
  return [...requests.values()]
}

function resolveQuote(quotes, market, lot, quantity) {
  if (!quotes || !market || !lot || !Number.isFinite(quantity)) return undefined
  return quotes[quoteMapKey(market, lot, quantity)]
}

function uniquePoolsFor(catalog, market, lot) {
  const seen = new Set()
  return poolsFor(catalog, market, lot).filter(pool => {
    if (seen.has(pool.id)) return false
    seen.add(pool.id)
    return true
  })
}

function stockOf(catalog, inquiryId, pools) {
  const poolIds = new Set(pools.map(pool => pool.id))
  const own = catalog.warehouse.reservations.filter(row =>
    row.inquiry === inquiryId && row.active && poolIds.has(row.pool))
  return {
    poolIds,
    pools,
    physicalKits: roundQuantity(sum(pools.map(pool => pool.physicalKits ?? 0))),
    reservedKits: roundQuantity(sum(pools.map(pool => pool.reservedKits ?? 0))),
    unreservedKits: roundQuantity(sum(pools.map(pool => pool.unreservedKits ?? 0))),
    ownKits: roundQuantity(sum(own.map(row => row.kits ?? 0))),
    ownReservations: own
  }
}

function optionSummary(option) {
  if (!option) return null
  return {
    key: option.key,
    market: option.market,
    sku: option.sku,
    lot: option.lot,
    pack: option.pack,
    quoteId: option.quoteId,
    current: option.current === true,
    source: option.source ?? null,
    href: option.href ?? null,
    title: option.title ?? null,
    identity: option.identity ?? null
  }
}

function packagingSummary(packaging) {
  if (!packaging) return null
  return {
    pack: packaging.pack ?? null,
    sku: packaging.sku ?? null,
    tree: packaging.tree,
    factors: packaging.factors,
    sealedEdges: packaging.sealedEdges
  }
}

function reservationSummary(row) {
  return {
    receipt: row.receipt,
    inquiry: row.inquiry,
    pool: row.pool,
    lot: row.lot,
    pack: row.pack,
    unit: row.unit,
    quantity: row.quantity,
    kits: row.kits,
    state: row.state,
    replacesReceipt: row.replacesReceipt,
    supersededBy: row.supersededBy ?? null
  }
}

export function requiredPackageCount(requiredKits, factor) {
  if (!Number.isFinite(requiredKits) || !factor) return null
  return ceilDiv(requiredKits, factor)
}

function currentOptionFor(catalog, inquiry, candidates = null) {
  const list = candidates ?? optionCandidatesFor(catalog, inquiry)
  return list.find(option => option.current) ??
    (inquiry.market
      ? catalog.currentOptions.find(option => option.market === inquiry.market) ?? null
      : null)
}

function originalOptionFor(catalog, inquiry) {
  if (!inquiry.original) return null
  return catalog.options.find(option => option.market === inquiry.original.market &&
    option.lot === inquiry.original.lot &&
    (!inquiry.original.pack || option.pack === inquiry.original.pack)) ?? inquiry.original
}

function governingOptionFor(catalog, inquiry, candidates = null) {
  const original = originalOptionFor(catalog, inquiry)
  const current = currentOptionFor(catalog, inquiry, candidates)
  return inquiry.signed ? (original ?? current) : (current ?? original)
}

/** Which old-batch contexts may supply an unconfirmed inquiry's old share. */
function findOldContexts(catalog, inquiry, governing, usedPoolIds = new Set()) {
  const contexts = []
  const seen = new Set()
  const push = (option, replacement, reason) => {
    if (!option?.market || !option?.lot) return
    if (governing && option.market === governing.market && option.lot === governing.lot &&
        (option.pack ?? null) === (governing.pack ?? null)) return
    const id = key(option.market, option.lot, option.pack ?? '')
    if (seen.has(id)) return
    seen.add(id)
    contexts.push({ option, replacement, reason })
  }
  if (inquiry.original) {
    push({
      ...inquiry.original,
      key: key(inquiry.original.market, inquiry.original.sku, inquiry.original.lot,
        inquiry.original.pack, inquiry.original.quoteId)
    }, null, '该询价保存的旧批上下文')
  }
  for (const row of catalog.lots) {
    if (row.market !== inquiry.market || !row.replacement?.old) continue
    if (governing && row.lot !== governing.lot) continue
    const known = optionForLot(catalog, inquiry.market, row.replacement.old)
    push(known
      ? { ...known, current: false, source: 'historical-quote' }
      : {
          key: key(inquiry.market, null, row.replacement.old, row.replacement.oldPack, null),
          market: inquiry.market,
          sku: null,
          lot: row.replacement.old,
          pack: row.replacement.oldPack,
          quoteId: null,
          source: 'replacement-declaration',
          current: false,
          packaging: row.replacement.packaging,
          identity: { matchedBy: 'replacement-declaration', merged: true }
        }, row.replacement, `批号 ${row.lot} 声明从 ${row.replacement.old} 接续`)
  }
  return contexts.map(context => ({
    ...context,
    pools: uniquePoolsFor(catalog, context.option.market, context.option.lot)
      .filter(pool => !usedPoolIds.has(pool.id))
  })).filter(context => context.pools.length || context.replacement)
}

/**
 * Deterministic planning allocation.
 *
 * `remaining` starts at each pool's unreserved remainder.  Inquiries are
 * visited in source order; a signed inquiry contributes nothing new (its
 * reservations are already subtracted from the pool), while an unconfirmed
 * inquiry may reserve its needed whole sale units from the pools its current
 * option maps to.  Old-share conversion then uses whatever is left.  The
 * result is only a plan: the buyer sees it labelled as such until the
 * warehouse issues receipts.
 */
export function buildAllocation(catalog, quotes = {}) {
  const remaining = new Map(catalog.warehouse.pools.map(pool =>
    [pool.id, roundQuantity(pool.unreservedKits ?? 0)]))
  const byInquiry = new Map()
  const demandKits = new Map(catalog.warehouse.pools.map(pool => [pool.id, 0]))

  const take = (poolId, wantedPackages, factor) => {
    const available = remaining.get(poolId) ?? 0
    const packages = Math.min(wantedPackages, floorDiv(available, factor) ?? 0)
    if (packages <= 0) return 0
    const kits = roundQuantity(packages * factor)
    remaining.set(poolId, roundQuantity(available - kits))
    return kits
  }

  for (const inquiry of catalog.inquiries) {
    const entry = {
      inquiry: inquiry.id,
      market: inquiry.market,
      signed: inquiry.signed,
      requiredKits: inquiry.requiredKits,
      current: null,
      old: [],
      plannedKits: 0,
      contested: []
    }
    byInquiry.set(inquiry.id, entry)
    if (!inquiry.market) continue
    const candidates = optionCandidatesFor(catalog, inquiry)
    const governing = governingOptionFor(catalog, inquiry, candidates)
    if (!governing) continue

    if (inquiry.signed) {
      const own = catalog.warehouse.reservations.filter(row =>
        row.inquiry === inquiry.id && row.active)
      entry.current = {
        kind: 'confirmed',
        against: optionSummary(governing),
        kits: roundQuantity(sum(own.map(row => row.kits ?? 0))),
        receipts: own.map(row => row.receipt),
        pools: Object.fromEntries(own.filter(row => row.pool).map(row => {
          const total = own.filter(candidate => candidate.pool === row.pool)
            .reduce((sum_, candidate) => sum_ + (candidate.kits ?? 0), 0)
          return [row.pool, roundQuantity(total)]
        }))
      }
      entry.plannedKits = entry.current.kits
      continue
    }

    const currentPools = uniquePoolsFor(catalog, governing.market, governing.lot)
    const requiredKits = inquiry.requiredKits
    // An unconfirmed inquiry may already hold its own confirmed receipts
    // (for example a warehouse confirmation on the current batch).  Those
    // are its own reserved stock and are available to it before any
    // unconfirmed plan is drawn from the pool's unreserved remainder.
    const own = catalog.warehouse.reservations.filter(row =>
      row.inquiry === inquiry.id && row.active)
    const ownByPool = new Map()
    for (const row of own) {
      if (!row.pool || !Number.isFinite(row.kits)) continue
      ownByPool.set(row.pool, roundQuantity((ownByPool.get(row.pool) ?? 0) + row.kits))
    }
    if (requiredKits === null) {
      entry.current = {
        kind: 'pending',
        against: optionSummary(governing),
        reason: inquiry.quantityError ?? '需求数量无法换算成组件数',
        pools: {}
      }
      continue
    }
    for (const pool of currentPools) {
      demandKits.set(pool.id, roundQuantity((demandKits.get(pool.id) ?? 0) + requiredKits))
    }
    const quote = normalizeQuote(resolveQuote(quotes, governing.market, governing.lot,
      requiredKits), governing.packaging)
    if (quote.state !== 'published' || !quote.convertible) {
      entry.current = {
        kind: 'pending',
        against: optionSummary(governing),
        quote,
        reason: quote.reason ?? '等待该市场交货报价',
        pools: {}
      }
      continue
    }
    const factor = quote.saleUnitKits
    const needed = requiredPackageCount(requiredKits, factor) ?? 0
    const minimum = quote.min ?? 0
    const maxPackages = quote.maximum === null ? Infinity : quote.maximum
    const targetPackages = Math.min(Math.max(needed, minimum), maxPackages)
    const pools = {}
    const ownPools = {}
    const unreservedPools = {}
    let coveredPackages = 0
    for (const pool of currentPools) {
      const ownKits = ownByPool.get(pool.id) ?? 0
      if (ownKits <= 0) continue
      const ownPackages = floorDiv(ownKits, factor) ?? 0
      if (ownPackages <= 0) continue
      const used = Math.min(ownPackages, targetPackages - coveredPackages)
      if (used <= 0) continue
      pools[pool.id] = roundQuantity(used * factor)
      ownPools[pool.id] = roundQuantity(used * factor)
      entry.ownReserved = roundQuantity((entry.ownReserved ?? 0) + used * factor)
      coveredPackages += used
    }
    let unallocatedPackages = Math.max(0, targetPackages - coveredPackages)
    for (const pool of currentPools) {
      if (unallocatedPackages <= 0) break
      const kits = take(pool.id, unallocatedPackages, factor)
      if (kits > 0) {
        pools[pool.id] = roundQuantity((pools[pool.id] ?? 0) + kits)
        unreservedPools[pool.id] = roundQuantity((unreservedPools[pool.id] ?? 0) + kits)
        unallocatedPackages -= floorDiv(kits, factor) ?? 0
      }
    }
    entry.current = {
      kind: 'planned',
      against: optionSummary(governing),
      quote,
      requiredKits,
      requiredPackages: needed,
      minPackages: minimum,
      targetPackages,
      plannedPackages: targetPackages - unallocatedPackages,
      plannedKits: roundQuantity((targetPackages - unallocatedPackages) * factor),
      capacityPackages: targetPackages - unallocatedPackages,
      ownReservedKits: entry.ownReserved ?? 0,
      ownPools,
      unreservedPools,
      pools
    }
    if (unallocatedPackages > 0) entry.current.unallocatedPackages = unallocatedPackages
    entry.plannedKits = entry.current.plannedKits

    // Old share only fills the gap the current option cannot cover.
    let gapPackages = Math.max(0, needed - entry.current.plannedPackages)
    if (gapPackages <= 0) continue
    const oldContexts = findOldContexts(catalog, inquiry, governing)
    for (const context of oldContexts) {
      if (gapPackages <= 0) break
      if (!context.pools.length) continue
      const oldQuote = normalizeQuote(resolveQuote(quotes, context.option.market,
        context.option.lot, requiredKits), context.option.packaging)
      if (oldQuote.state !== 'published' || !oldQuote.convertible) continue
      const oldFactor = oldQuote.saleUnitKits
      const declared = context.replacement && Number.isFinite(context.replacement.unitsKits)
        ? Math.max(0, context.replacement.unitsKits)
        : Infinity
      const share = {
        against: optionSummary(context.option),
        quote: oldQuote,
        reason: context.reason,
        replacement: context.replacement ? {
          old: context.replacement.old,
          oldPack: context.replacement.oldPack,
          unitsKits: context.replacement.unitsKits,
          fromUnreservedOnly: context.replacement.fromUnreservedOnly
        } : null,
        pools: {},
        kits: 0,
        packages: 0
      }
      let sharePackages = Math.min(gapPackages,
        floorDiv(declared, oldFactor) ?? 0)
      for (const pool of context.pools) {
        if (sharePackages <= 0) break
        const kits = take(pool.id, sharePackages, oldFactor)
        if (kits > 0) {
          const packages = floorDiv(kits, oldFactor) ?? 0
          share.pools[pool.id] = roundQuantity((share.pools[pool.id] ?? 0) + kits)
          share.kits = roundQuantity(share.kits + kits)
          share.packages += packages
          sharePackages -= packages
          gapPackages -= packages
          entry.plannedKits = roundQuantity(entry.plannedKits + kits)
        }
      }
      if (share.kits > 0) entry.old.push(share)
    }
  }

  return {
    byInquiry,
    remaining,
    demandKits,
    remainingAfterPlanning: Object.fromEntries([...remaining].map(([id, kits]) =>
      [id, roundQuantity(kits)])),
    order: catalog.inquiries.map(inquiry => inquiry.id)
  }
}

function evaluateOldShare(catalog, inquiry, context, quotes, allocationShare, maxKits = null) {
  const { option, replacement, reason } = context
  const pools = context.pools
  const stock = stockOf(catalog, inquiry.id, pools)
  const record = resolveQuote(quotes, option.market, option.lot, inquiry.requiredKits)
  const quote = normalizeQuote(record, option.packaging)

  const declaredKits = replacement && Number.isFinite(replacement.unitsKits)
    ? replacement.unitsKits
    : null
  const physicalKits = stock.physicalKits
  // Reserved stock belongs to the confirmed receipt that owns it.  An
  // unconfirmed inquiry can use the unreserved remainder; a warehouse may
  // narrow that further to unreserved stock only.  A partial replacement
  // (`units`) caps the convertible quantity as well.
  const declaredCeiling = replacement?.fromUnreservedOnly === true
    ? stock.unreservedKits
    : stock.unreservedKits + stock.ownKits
  let convertibleKits = roundQuantity(declaredCeiling)
  if (declaredKits !== null) convertibleKits = roundQuantity(Math.min(convertibleKits, declaredKits))
  if (allocationShare) convertibleKits = roundQuantity(Math.min(convertibleKits, allocationShare.kits))
  // Old share only fills what the new option cannot cover.
  if (maxKits !== null) convertibleKits = roundQuantity(Math.min(convertibleKits, Math.max(0, maxKits)))

  const factor = quote.state === 'published' && quote.convertible
    ? quote.saleUnitKits
    : null
  const packages = factor ? floorDiv(convertibleKits, factor) ?? 0 : null
  const deliverableKits = packages === null ? convertibleKits : roundQuantity(packages * factor)

  const limitReasons = []
  const blockers = []
  // Informational caps: they explain the declared old share even when some of
  // it is convertible.
  if (replacement?.fromUnreservedOnly === true) {
    limitReasons.push('仓库只准转换未预留份额')
  }
  if (declaredKits !== null) {
    limitReasons.push(`仓库只列出 ${declaredKits} 个组件的替代份额`)
  }
  // Real blockers: nothing at all can be converted.
  if (physicalKits === 0) blockers.push('旧批仓池没有实物库存')
  if (physicalKits === null) blockers.push('旧批仓池缺少可换算的包装资料')
  if (!pools.length) blockers.push('旧批没有明确属于该市场的仓池')
  if (declaredCeiling === 0) blockers.push('旧批未预留份额已被其他确认占用')
  if (allocationShare && allocationShare.kits < declaredCeiling && allocationShare.kits === 0) {
    blockers.push('同池其他询价已先占用本池未预留份额')
  }
  if (convertibleKits === 0 && declaredKits !== null && declaredCeiling > 0) {
    blockers.push(`替代份额不足一个旧包装销售单位，实际可转换 ${convertibleKits}/${declaredKits} 个组件`)
  }
  if (factor && convertibleKits > 0 && packages === 0) {
    blockers.push(`可转换的 ${convertibleKits} 个组件不足一个旧包装${quote.saleUnit}，不能整包装交货`)
  }

  return {
    reason,
    option: optionSummary(option),
    quote,
    packaging: packagingSummary(option.packaging),
    pools: pools.map(summarizePool),
    replacement: replacement ? {
      old: replacement.old,
      oldPack: replacement.oldPack,
      units: replacement.units,
      unit: replacement.unit,
      unitsKits: replacement.unitsKits,
      effectiveBatch: replacement.effectiveBatch,
      fromUnreservedOnly: replacement.fromUnreservedOnly,
      partial: replacement.partial
    } : null,
    declaredKits,
    physicalKits,
    convertibleKits,
    limitReasons,
    blockers,
    skipReason: deliverableKits === 0 && blockers.length ? blockers.join('；') : null,
    deliverable: {
      unit: quote.state === 'published' ? quote.saleUnit : null,
      quantity: packages,
      kits: deliverableKits,
      fullPackage: factor !== null,
      quotePending: quote.state !== 'published',
      basis: replacement?.fromUnreservedOnly === true
        ? '旧批替代份额，仅限仓库未预留部分'
        : '旧批替代份额'
    },
    canShipKits: deliverableKits
  }
}

function signedDelivery(catalog, inquiry, option) {
  const own = catalog.warehouse.reservations.filter(row =>
    row.inquiry === inquiry.id && row.active)
  const lines = own.map(row => {
    const packaging = row.packaging ?? option.packaging ?? null
    const unitKits = packaging && row.unit ? packaging.factorTo(row.unit, KIT) : null
    return {
      receipt: row.receipt,
      pool: row.pool,
      lot: row.lot,
      pack: row.pack,
      unit: row.unit,
      quantity: row.quantity,
      kits: row.kits,
      unitKits,
      replacesReceipt: row.replacesReceipt
    }
  })
  const units = [...new Set(lines.map(line => line.unit).filter(Boolean))]
  const packs = [...new Set(lines.map(line => line.pack).filter(Boolean))]
  const kits = roundQuantity(sum(lines.map(line => line.kits ?? 0)))
  // Interpret the confirmed quantity with the packaging that applied to each
  // reservation line.  A line recorded in pallets stays pallets even when a
  // newer packaging was published later.  Mixed units are reported as
  // separate lines rather than being added into one meaningless number.
  const allSameUnit = units.length === 1
  const quantity = allSameUnit
    ? roundQuantity(sum(lines.map(line => line.quantity ?? 0)))
    : null
  return {
    lines,
    kits,
    units,
    unit: allSameUnit ? units[0] : null,
    quantity,
    packages: quantity,
    mixedPacks: packs.length > 1,
    mixedUnits: units.length > 1,
    replacementReceipts: lines.filter(line => line.replacesReceipt),
    packs
  }
}

function evaluateGoverning(catalog, inquiry, option, quotes, signed, allocationEntry) {
  let pools = uniquePoolsFor(catalog, option.market, option.lot)
  // A confirmed inquiry may have been moved to a different pool by its own
  // replacement confirmation; the warehouse receipt is the authority for
  // where the goods actually sit.
  if (signed) {
    const receiptPoolIds = new Set(catalog.warehouse.reservations
      .filter(row => row.inquiry === inquiry.id && row.active && row.pool)
      .map(row => row.pool))
    pools = [...pools, ...catalog.warehouse.pools.filter(pool =>
      receiptPoolIds.has(pool.id) && !pools.some(known => known.id === pool.id))]
  }
  if (!pools.length) {
    return {
      status: 'no-pool',
      reason: `仓库没有为 ${option.market}/${option.lot} 明确给出可用仓池；不能凭批号把来源合账`,
      option: optionSummary(option),
      quote: null,
      packaging: packagingSummary(option.packaging),
      pools: [],
      deliverable: null,
      required: {
        kits: inquiry.requiredKits,
        unit: inquiry.unit,
        quantity: inquiry.quantity
      },
      gap: null
    }
  }
  const stock = stockOf(catalog, inquiry.id, pools)
  const record = resolveQuote(quotes, option.market, option.lot, inquiry.requiredKits)
  const quote = normalizeQuote(record, option.packaging)
  const required = {
    kits: inquiry.requiredKits,
    unit: inquiry.unit,
    quantity: inquiry.quantity
  }

  if (signed) {
    const delivery = signedDelivery(catalog, inquiry, option)
    const usedReplacement = delivery.replacementReceipts.length > 0
    const replacementPools = [...new Set(delivery.replacementReceipts.map(line => line.pool))]
    const gapKits = inquiry.requiredKits === null
      ? null
      : roundQuantity(Math.max(0, inquiry.requiredKits - delivery.kits))
    // The gap is expressed in the unit of the confirmed reservation, because
    // that is the unit the buyer signed and the warehouse confirmed.
    const gapUnit = delivery.unit
    const gapUnitKits = delivery.lines.length && delivery.unit
      ? delivery.lines.find(line => line.unit === delivery.unit)?.unitKits ?? null
      : null
    const gapPackages = delivery.unit && gapUnitKits
      ? ceilDiv(gapKits ?? 0, gapUnitKits)
      : null
    return {
      status: delivery.kits > 0 &&
        (inquiry.requiredKits === null || delivery.kits >= inquiry.requiredKits)
        ? 'ready'
        : 'short',
      signed: true,
      option: optionSummary(option),
      quote,
      packaging: packagingSummary(option.packaging),
      pools: pools.map(summarizePool),
      stock: {
        physicalKits: stock.physicalKits,
        reservedKits: stock.reservedKits,
        unreservedKits: stock.unreservedKits,
        ownKits: stock.ownKits,
        capacityKits: stock.ownKits
      },
      deliverable: {
        unit: delivery.unit,
        quantity: delivery.quantity,
        kits: delivery.kits,
        packages: delivery.packages,
        fullPackage: delivery.unit !== null && delivery.quantity !== null,
        mixedPacks: delivery.mixedPacks,
        basis: '该询价自己的有效预留确认',
        lines: delivery.lines,
        packs: delivery.packs,
        usesReplacementConfirmation: usedReplacement
      },
      originalTerms: {
        market: inquiry.original?.market ?? null,
        lot: inquiry.original?.lot ?? null,
        pack: inquiry.original?.pack ?? null,
        quoteId: inquiry.original?.quoteId ?? null,
        saleUnit: delivery.unit ?? (quote.state === 'published' ? quote.saleUnit : null),
        price: quote.state === 'published' ? quote.price : null,
        currency: quote.state === 'published' ? quote.currency : null,
        delivery: quote.state === 'published' ? quote.delivery : null,
        note: '确认单保留原销售单位、报价与已给仓位；未取得本询价自己的替换确认前不动用新批'
      },
      replacementConfirmation: {
        received: usedReplacement,
        receipts: delivery.replacementReceipts.map(line => ({
          receipt: line.receipt,
          replacesReceipt: line.replacesReceipt,
          pool: line.pool,
          lot: line.lot,
          pack: line.pack
        })),
        pools: replacementPools,
        note: usedReplacement
          ? '本询价已取得替换确认，新批仓位按确认编号计入'
          : '本询价没有自己的替换确认，新批库存不计入'
      },
      required,
      gap: {
        kits: gapKits,
        packages: gapPackages,
        unit: delivery.unit
      }
    }
  }

  const base = {
    option: optionSummary(option),
    quote,
    packaging: packagingSummary(option.packaging),
    pools: pools.map(summarizePool),
    stock: {
      physicalKits: stock.physicalKits,
      reservedKits: stock.reservedKits,
      unreservedKits: stock.unreservedKits,
      ownKits: stock.ownKits
    },
    required
  }
  const planned = allocationEntry?.current?.kind === 'planned' &&
    allocationEntry.current.against?.key === option.key
    ? allocationEntry.current
    : null
  const plannedKits = planned
    ? roundQuantity(sum(Object.entries(planned.pools)
        .filter(([poolId]) => pools.some(pool => pool.id === poolId))
        .map(([, kits]) => kits)))
    : null
  const capacityKits = plannedKits !== null
    ? plannedKits
    : roundQuantity(stock.unreservedKits + stock.ownKits)

  if (!option.packaging) {
    return {
      ...base,
      status: 'no-packaging',
      reason: `市场选项 ${option.market}/${option.lot} 缺少包装资料，无法判断整包装可交量`,
      stock: { ...base.stock, capacityKits: null },
      deliverable: null,
      gap: { kits: inquiry.requiredKits, packages: null, minimumShortfallKits: null }
    }
  }
  if (quote.state !== 'published') {
    return {
      ...base,
      status: 'quote-pending',
      reason: quote.reason,
      stock: { ...base.stock, capacityKits: roundQuantity(capacityKits) },
      deliverable: capacityKits > 0 && quote.observedEarlier
        ? {
            unit: null,
            quantity: null,
            kits: capacityKits,
            packages: null,
            fullPackage: false,
            basis: '库存可用，但该市场的新交货报价仍未公布'
          }
        : null,
      gap: {
        kits: inquiry.requiredKits === null
          ? null
          : roundQuantity(Math.max(0, inquiry.requiredKits - capacityKits)),
        packages: null,
        unit: null
      }
    }
  }
  if (!quote.convertible) {
    return {
      ...base,
      status: 'quote-unit-unknown',
      reason: quote.reason,
      stock: { ...base.stock, capacityKits: roundQuantity(capacityKits) },
      deliverable: null,
      gap: { kits: inquiry.requiredKits, packages: null, unit: quote.saleUnit }
    }
  }

  const factor = quote.saleUnitKits
  const capacityPackages = floorDiv(capacityKits, factor) ?? 0
  const maxPackages = quote.maximum === null ? Infinity : quote.maximum
  const capacityByQuote = Math.min(capacityPackages, maxPackages)
  const neededPackages = requiredPackageCount(inquiry.requiredKits, factor)
  const minimumPackages = quote.min ?? 0
  const minimumMet = capacityByQuote >= minimumPackages
  const wantedPackages = neededPackages === null
    ? capacityByQuote
    : Math.max(neededPackages, minimumPackages)
  const shipPackages = Math.min(capacityByQuote, wantedPackages)
  const shipKits = roundQuantity(shipPackages * factor)
  const neededKits = neededPackages === null
    ? inquiry.requiredKits
    : roundQuantity(neededPackages * factor)
  const exceedsRequested = inquiry.requiredKits !== null && shipKits > inquiry.requiredKits
  const shortOfRequest = inquiry.requiredKits !== null && shipKits < inquiry.requiredKits

  let status
  if (capacityKits <= 0) status = 'no-stock'
  else if (!minimumMet) status = 'minimum-short'
  else if (shortOfRequest) status = 'stock-short'
  else if (exceedsRequested) status = 'exceeds-requested'
  else status = 'ready'

  return {
    ...base,
    status,
    stock: { ...base.stock, capacityKits: roundQuantity(capacityKits) },
    // A shipment below the quote's minimum order is not actually deliverable;
    // the capacity is still shown so the buyer can see the gap explicitly.
    deliverable: minimumMet
      ? {
          unit: quote.saleUnit,
          quantity: shipPackages,
          kits: shipKits,
          packages: shipPackages,
          fullPackage: true,
          shippable: true,
          basis: planned
            ? '按来源顺序分配后，本询价可用的未预留库存与整包装取整'
            : '仓库可用库存与报价整包装取整后的可交量',
          planned: Boolean(planned),
          capacityPackages: capacityByQuote,
          capacityKits: roundQuantity(capacityByQuote * factor),
          minOrderKits: quote.minKits,
          minimumMet,
          buyerDecisionRequired: exceedsRequested
        }
      : null,
    capacity: {
      unit: quote.saleUnit,
      quantity: capacityByQuote,
      kits: roundQuantity(capacityByQuote * factor),
      minOrderKits: quote.minKits,
      minimumMet
    },
    required: {
      ...required,
      packages: neededPackages,
      kitsInSaleUnits: neededKits
    },
    exceedsRequested: minimumMet && exceedsRequested,
    excessKits: minimumMet && inquiry.requiredKits !== null
      ? roundQuantity(Math.max(0, shipKits - inquiry.requiredKits))
      : 0,
    gap: {
      // Gap is measured against the buyer's stated need, not against the
      // rounding-up target: if the request needs three pallets and none can
      // ship, the gap is the requested kits plus the whole-package count
      // required to cover them.
      kits: inquiry.requiredKits === null
        ? null
        : roundQuantity(Math.max(0, inquiry.requiredKits - (minimumMet ? shipKits : 0))),
      packages: minimumMet
        ? Math.max(0, (neededPackages ?? 0) - shipPackages)
        : Math.max(0, minimumPackages - capacityByQuote, neededPackages ?? 0),
      unit: quote.saleUnit,
      minimumShortfallKits: minimumMet
        ? 0
        : roundQuantity(Math.max(0, quote.minKits - capacityByQuote * factor)),
      minimumShortfallPackages: minimumMet
        ? 0
        : Math.max(0, minimumPackages - capacityByQuote)
    }
  }
}

export function analyzeInquiry(catalog, inquiryOrId, quotes = {}, allocation = null) {
  const inquiry = typeof inquiryOrId === 'string'
    ? catalog.inquiries.find(row => row.id === inquiryOrId)
    : inquiryOrId
  if (!inquiry) {
    return {
      ok: false,
      status: 'unknown-inquiry',
      reason: `没有询价 ${String(inquiryOrId)}`,
      inquiryId: typeof inquiryOrId === 'string' ? inquiryOrId : null
    }
  }

  const candidates = optionCandidatesFor(catalog, inquiry)
  const governing = governingOptionFor(catalog, inquiry, candidates)
  const allocationEntry = allocation?.byInquiry?.get(inquiry.id) ?? null

  const warnings = []
  if (inquiry.requiredKits === null) {
    warnings.push({
      code: 'inquiry-quantity-unknown',
      message: inquiry.quantityError ?? '询价需求数量无法换算成组件数'
    })
  }
  if (!governing) {
    return {
      ok: false,
      status: 'no-option',
      inquiry,
      candidates: candidates.map(optionSummary),
      reason: `市场 ${inquiry.market} 没有可用的目的地选项`,
      warnings
    }
  }

  const governingResult = evaluateGoverning(catalog, inquiry, governing, quotes,
    inquiry.signed, allocationEntry)
  const governingPoolIds = new Set(asArray(governingResult.pools).map(pool => pool.id))

  const oldShares = []
  if (!inquiry.signed) {
    const shortfallKits = governingResult.gap?.kits ??
      inquiry.requiredKits
    for (const context of findOldContexts(catalog, inquiry, governing, governingPoolIds)) {
      const plannedShare = allocationEntry?.old?.find(share =>
        share.against?.key === context.option.key)
      const share = evaluateOldShare(catalog, inquiry, context, quotes, plannedShare,
        shortfallKits)
      if (share.declaredKits > 0 || share.canShipKits > 0 || share.physicalKits > 0) {
        oldShares.push(share)
      }
    }
  }
  const oldShareKits = roundQuantity(sum(oldShares.map(share => share.deliverable.kits)))

  const ownReservations = catalog.warehouse.reservations.filter(row =>
    row.inquiry === inquiry.id)

  const evidence = {
    destinationOption: optionSummary(governing),
    quote: governingResult.quote ?? null,
    deliveryTerms: {
      market: governing.market,
      saleUnit: governingResult.quote?.saleUnit ?? null,
      min: governingResult.quote?.min ?? null,
      maximum: governingResult.quote?.maximum ?? null,
      price: governingResult.quote?.price ?? null,
      currency: governingResult.quote?.currency ?? null,
      delivery: governingResult.quote?.delivery ?? null
    },
    packaging: governingResult.packaging ?? null,
    pools: governingResult.pools ?? [],
    oldShares: oldShares.map(share => ({
      lot: share.option.lot,
      pack: share.option.pack,
      quote: share.quote,
      packaging: share.packaging,
      pools: share.pools,
      replacement: share.replacement
    })),
    reservations: ownReservations.map(reservationSummary),
    allocation: allocationEntry
  }
  if (inquiry.signed) evidence.replacementConfirmation = governingResult.replacementConfirmation

  const pending = []
  if (governingResult.status === 'quote-pending') {
    pending.push({ code: 'market-quote-pending', message: governingResult.reason })
  }
  if (governingResult.status === 'no-pool') {
    pending.push({ code: 'no-applicable-pool', message: governingResult.reason })
  }
  if (governingResult.status === 'no-packaging') {
    pending.push({ code: 'no-packaging', message: governingResult.reason })
  }
  if (governingResult.status === 'no-stock') {
    pending.push({
      code: 'no-unreserved-stock',
      message: `仓池 ${governingResult.pools.map(pool => pool.id).join('、')} 没有本询价可用的未预留份额`
    })
  }
  if (governingResult.status === 'minimum-short') {
    pending.push({
      code: 'minimum-order-short',
      message: `新包装最低订量还差 ${governingResult.gap.minimumShortfallPackages} 个${governingResult.quote?.saleUnit ?? '销售单位'}（${governingResult.gap.minimumShortfallKits} 个组件）`
    })
  }
  if (governingResult.status === 'stock-short') {
    pending.push({
      code: 'stock-short',
      message: `可交 ${governingResult.deliverable.kits} 个组件，还差 ${governingResult.gap.kits} 个组件`
    })
  }
  if (governingResult.exceedsRequested) {
    pending.push({
      code: 'buyer-decision-excess',
      message: `整包装交货为 ${governingResult.deliverable.quantity} ${governingResult.deliverable.unit}（${governingResult.deliverable.kits} 个组件），超出所需 ${governingResult.excessKits} 个组件，等待买家确认`
    })
  }
  if (!inquiry.signed && governingResult.status !== 'ready' &&
      governingResult.status !== 'exceeds-requested') {
    if (oldShareKits > 0) {
      pending.push({
        code: 'old-share-available',
        message: `旧批可交份额 ${oldShareKits} 个组件（${oldShares
          .map(share => `${share.option.lot}/${share.option.pack ?? '?'}: ${share.deliverable.kits}`)
          .join('，')}），需买家决定是否接受旧包装交付`
      })
    }
    for (const share of oldShares.filter(item => item.canShipKits === 0 && item.skipReason)) {
      pending.push({
        code: 'old-share-blocked',
        message: `旧批 ${share.option.lot} 的份额不能转换：${share.skipReason}`,
        lot: share.option.lot
      })
    }
  }
  for (const warning of warnings) {
    pending.push({ code: warning.code, message: warning.message })
  }

  const status = inquiry.signed
    ? governingResult.status
    : (governingResult.status === 'ready' || governingResult.status === 'exceeds-requested')
      ? governingResult.status
      : oldShareKits > 0 ? 'old-share-only' : governingResult.status

  return {
    ok: true,
    inquiry: {
      id: inquiry.id,
      sku: inquiry.sku,
      market: inquiry.market,
      signed: inquiry.signed,
      state: inquiry.state,
      quantity: inquiry.quantity,
      unit: inquiry.unit,
      requiredKits: inquiry.requiredKits,
      quantityError: inquiry.quantityError ?? null
    },
    status,
    governing: governingResult,
    oldShares,
    oldShareKits,
    candidates: candidates.map(option => ({
      ...optionSummary(option),
      packaging: packagingSummary(option.packaging),
      quote: normalizeQuote(resolveQuote(quotes, option.market, option.lot,
        inquiry.requiredKits), option.packaging)
    })),
    sharedPoolPeers: [],
    evidence,
    pending,
    warnings
  }
}

export function analyzeAll(catalog, quotes = {}) {
  const allocation = buildAllocation(catalog, quotes)
  const analyses = catalog.inquiries.map(inquiry =>
    analyzeInquiry(catalog, inquiry, quotes, allocation))
  annotateSharedPools(catalog, analyses)
  return { analyses, allocation }
}

/**
 * Explain which other inquiries see the same physical pool and why they
 * cannot copy this conclusion.  Quantity always follows the peer's own
 * demand and market option.
 */
export function annotateSharedPools(catalog, analyses) {
  for (const analysis of analyses) {
    if (!analysis.ok) continue
    const ownPools = new Set([
      ...asArray(analysis.governing?.pools).map(pool => pool.id),
      ...asArray(analysis.oldShares).flatMap(share =>
        asArray(share.pools).map(pool => pool.id))
    ])
    if (!ownPools.size) continue
    const peers = []
    for (const other of analyses) {
      if (other === analysis || !other.ok) continue
      const peerPools = new Set([
        ...asArray(other.governing?.pools).map(pool => pool.id),
        ...asArray(other.oldShares).flatMap(share =>
          asArray(share.pools).map(pool => pool.id))
      ])
      const shared = [...peerPools].filter(id => ownPools.has(id))
      if (!shared.length) continue
      const peerReceipts = catalog.warehouse.reservations
        .filter(row => row.inquiry === other.inquiry.id && row.active &&
          shared.includes(row.pool))
        .map(reservationSummary)
      const multiMarket = catalog.warehouse.pools
        .some(pool => shared.includes(pool.id) && pool.markets.length > 1)
      if (!peerReceipts.length && !multiMarket) continue
      peers.push({
        inquiry: other.inquiry.id,
        market: other.inquiry.market,
        signed: other.inquiry.signed,
        requiredKits: other.inquiry.requiredKits,
        unit: other.inquiry.unit,
        sharedPools: shared,
        status: other.status,
        plannedKits: other.evidence?.allocation?.plannedKits ?? 0,
        receipts: peerReceipts,
        reason: peerReceipts.length
          ? `同池询价 ${other.inquiry.id}（${other.inquiry.market}）已有本池有效确认 ${peerReceipts
              .map(row => row.receipt).join('、')}，这些份额已从池中扣减；它的销售单位和需求与本询价不同，结论不能照搬`
          : `同池询价 ${other.inquiry.id}（${other.inquiry.market}）共用仓池 ${shared.join('、')}，其需求为 ${other.inquiry.requiredKits ?? '未知'} 个组件（${other.inquiry.unit ?? '单位未知'}），未预留余量要同时满足双方，不能各占一遍`
      })
    }
    analysis.sharedPoolPeers = peers
  }
  return analyses
}

/**
 * Compact answer for a buyer/采购 screen: what is certain, what still needs a
 * warehouse confirmation or a new price.
 */
export function inquiryReport(analysis) {
  if (!analysis?.ok) return analysis
  const parts = []
  const governing = analysis.governing
  const base = {
    market: analysis.inquiry.market,
    lot: governing.option?.lot ?? null,
    pack: governing.option?.pack ?? null,
    quoteId: governing.quote?.id ?? null
  }
  if (analysis.inquiry.signed) {
    parts.push({
      part: '本次确认',
      status: governing.status,
      ...base,
      deliverableKits: governing.deliverable?.kits ?? 0,
      deliverableQuantity: governing.deliverable?.quantity ?? null,
      deliverableUnit: governing.deliverable?.unit ?? null,
      gapKits: governing.gap?.kits ?? null,
      basis: governing.deliverable?.basis ?? null,
      usedReplacementConfirmation:
        governing.deliverable?.usesReplacementConfirmation ?? false
    })
  } else {
    parts.push({
      part: '当前市场选项',
      status: governing.status,
      ...base,
      deliverableKits: governing.deliverable?.kits ?? 0,
      deliverableQuantity: governing.deliverable?.quantity ?? null,
      deliverableUnit: governing.deliverable?.unit ?? null,
      planned: governing.deliverable?.planned ?? false,
      exceedsRequested: governing.exceedsRequested ?? null,
      excessKits: governing.excessKits ?? null,
      gapKits: governing.gap?.kits ?? null,
      minimumShortfallKits: governing.gap?.minimumShortfallKits ?? 0,
      buyerDecisionRequired: governing.deliverable?.buyerDecisionRequired ?? false
    })
    for (const share of analysis.oldShares) {
      parts.push({
        part: '旧批可交份额',
        status: share.deliverable.kits > 0 ? 'available' : 'blocked',
        market: share.option.market,
        lot: share.option.lot,
        pack: share.option.pack,
        quoteId: share.quote.id ?? null,
        deliverableKits: share.deliverable.kits,
        deliverableQuantity: share.deliverable.quantity,
        deliverableUnit: share.deliverable.unit,
        declaredKits: share.declaredKits,
        limitReasons: share.limitReasons
      })
    }
  }
  return {
    inquiry: analysis.inquiry,
    status: analysis.status,
    parts,
    pending: analysis.pending,
    sharedPoolPeers: analysis.sharedPoolPeers
  }
}
