/**
 * Turns a raw source snapshot into a deterministic catalogue.
 *
 * The interesting part is identity: a destination page and a wholesale
 * product may be the same model, but they are only merged when they share a
 * common identifier (SKU / market + lot + pack).  Quantities are never merged
 * across market options – sale unit, minimum order and delivery terms always
 * come from the option's own market.
 */

import { buildPackageModel, packagesHaveSameTree } from './packaging.mjs'
import { KIT, normalizeUnit, requestedKits } from './units.mjs'
import {
  asArray,
  key,
  nonNegativeInteger,
  roundQuantity,
  toFiniteNumber,
  unique
} from './util.mjs'

export const POOL_LINK_MARKET = 'market-declared'

/** Stable identity for remembered revisions of products/options. */
export function revisionKey(row) {
  return [
    row?.market ?? '', row?.sku ?? '', row?.lot ?? '', row?.pack ?? '', row?.quoteId ?? ''
  ].join('|')
}

function sortedProducts(products) {
  return [...products].sort((left, right) =>
    String(left.pack).localeCompare(String(right.pack)) ||
    String(left.market ?? '').localeCompare(String(right.market ?? '')) ||
    String(left.lot ?? '').localeCompare(String(right.lot ?? '')))
}

export function normalizeProducts(products) {
  return sortedProducts(asArray(products).filter(product => product && typeof product === 'object')
    .map(product => ({
      sku: product.sku ? String(product.sku) : null,
      pack: product.pack ? String(product.pack) : null,
      market: product.market ? String(product.market) : null,
      lot: product.lot ? String(product.lot) : null,
      tree: product.tree,
      raw: product,
      packaging: buildPackageModel(product.tree, {
        pack: product.pack ? String(product.pack) : null,
        sku: product.sku ? String(product.sku) : null,
        market: product.market ? String(product.market) : null,
        lot: product.lot ? String(product.lot) : null
      })
    })))
}

function specificity(product, want) {
  let score = 0
  if (product.pack === want.pack) score += 8
  if (product.market === want.market) score += 4
  if (product.lot === want.lot) score += 2
  if (product.market === null) score += 1
  if (product.lot === null) score += 1
  return score
}

/**
 * Find the wholesale product that describes one packaging context.  Returns
 * `ambiguous` instead of silently picking when two different SKUs fit equally
 * well; that is exactly the case where inventory must not be merged.
 */
export function chooseProduct(products, want = {}) {
  const candidates = products.filter(product =>
    (!want.pack || product.pack === want.pack) &&
    (!want.market || !product.market || product.market === want.market) &&
    (!want.lot || !product.lot || product.lot === want.lot))
  if (!candidates.length) return { packaging: null, product: null, candidates: [] }
  const scored = candidates.map(product => ({ product, score: specificity(product, want) }))
  const best = Math.max(...scored.map(entry => entry.score))
  const winners = scored.filter(entry => entry.score === best).map(entry => entry.product)
  const skus = unique(winners.map(product => product.sku).filter(Boolean))
  if (skus.length > 1) {
    return {
      packaging: null,
      product: null,
      candidates: winners,
      ambiguous: true,
      reason: `包装资料对应多个型号 ${skus.join('、')}，没有共同标识不能合并`
    }
  }
  return { packaging: winners[0].packaging, product: winners[0], candidates: winners }
}

/** Packaging for a lot when the pool/stock row does not name a pack. */
export function choosePackagingForLot(products, lot, market = null) {
  const contexts = products.filter(product => product.lot === lot &&
    (market === null || product.market === null || product.market === market))
  if (!contexts.length) return { packaging: null, reason: `批号 ${lot} 没有包装资料` }
  const uniqueFactorSets = unique(contexts.map(product => JSON.stringify(
    Object.entries(product.packaging.factors).sort(([left], [right]) => left.localeCompare(right)))))
  if (uniqueFactorSets.length > 1) {
    return {
      packaging: null,
      candidates: contexts,
      ambiguous: true,
      reason: `批号 ${lot} 在不同市场使用不同包装，不能把仓池折算合并`
    }
  }
  return { packaging: contexts[0].packaging, candidates: contexts }
}

export function buildMarketOptions(snapshot, products) {
  const options = []
  const warnings = []
  for (const page of asArray(snapshot.markets)) {
    for (const article of asArray(page.articles)) {
      if (!article.market || !article.lot) {
        warnings.push({
          code: 'market-article-incomplete',
          message: '目的地页面条目缺少市场或批号',
          article,
          href: page.href
        })
        continue
      }
      const chosen = chooseProduct(products, {
        pack: article.pack,
        market: article.market,
        lot: article.lot
      })
      if (chosen.ambiguous) {
        warnings.push({
          code: 'ambiguous-model-identity',
          message: chosen.reason,
          article,
          candidates: chosen.candidates.map(product => product.sku)
        })
      }
      if (!chosen.packaging) {
        warnings.push({
          code: 'missing-packaging',
          message: `目的地条目 ${article.market}/${article.lot}/${article.pack ?? '?'} 没有可用包装资料`,
          article
        })
      }
      const sku = article.sku && chosen.product?.sku && article.sku !== chosen.product.sku
        ? null
        : article.sku ?? chosen.product?.sku ?? null
      options.push({
        key: key(article.market, sku, article.lot, article.pack, article.quote),
        market: article.market,
        sku,
        lot: article.lot,
        pack: article.pack,
        quoteId: article.quote,
        href: article.href ?? page.href,
        title: article.title ?? page.title ?? null,
        source: 'destination',
        current: true,
        identity: {
          sku,
          matchedBy: article.sku ? 'page-sku' : chosen.product ? 'market+lot+pack' : 'none',
          merged: Boolean(article.sku && chosen.product?.sku && article.sku === chosen.product.sku) ||
            Boolean(!article.sku && chosen.product?.sku),
          pageSku: article.sku ?? null,
          productSku: chosen.product?.sku ?? null
        },
        packaging: chosen.packaging,
        product: chosen.product?.raw ?? null
      })
    }
  }
  return { options, warnings }
}

export function buildHistoricalOptions(snapshot, products) {
  const options = []
  for (const option of asArray(snapshot.historyOptions)) {
    const chosen = chooseProduct(products, {
      pack: option.pack,
      market: option.market,
      lot: option.lot
    })
    options.push({
      ...option,
      key: key(option.market, option.sku, option.lot, option.pack, option.quoteId),
      source: option.source ?? 'history',
      current: false,
      identity: {
        sku: option.sku ?? chosen.product?.sku ?? null,
        matchedBy: option.sku ? 'history-sku' : 'market+lot+pack',
        merged: true,
        productSku: chosen.product?.sku ?? null
      },
      packaging: chosen.packaging,
      product: chosen.product?.raw ?? null
    })
  }
  return options
}

/**
 * Old-lot option described by a replacement declaration.  Even when the old
 * page is gone the old quote id must remain readable; the caller supplies any
 * prior observation through `historyOptions`, otherwise the quote is looked up
 * by market/lot/quantity.
 */
export function replacementOption(lots, products, market, replacement) {
  if (!replacement?.old) return null
  const lot = String(replacement.old)
  const pack = replacement.oldPack ? String(replacement.oldPack) : null
  const chosen = chooseProduct(products, { pack, market, lot })
  const existing = lots.find(row => row.market === market && row.lot === lot)
  return {
    key: key(market, chosen.product?.sku, lot, pack, null),
    market,
    sku: chosen.product?.sku ?? null,
    lot,
    pack,
    quoteId: null,
    href: null,
    title: null,
    source: 'replacement-declaration',
    current: false,
    identity: {
      sku: chosen.product?.sku ?? null,
      matchedBy: 'replacement-declaration',
      merged: true,
      productSku: chosen.product?.sku ?? null
    },
    packaging: chosen.packaging,
    product: chosen.product?.raw ?? null,
    declaration: {
      effectiveBatch: replacement.effectiveBatch ?? null,
      replacementUnits: replacement.units ?? null,
      replacementUnit: replacement.unit ?? null,
      fromUnreservedOnly: replacement.fromUnreservedOnly === true,
      declaredAvailable: existing?.available ?? null
    }
  }
}

export function normalizeLots(lots, products, options) {
  return asArray(lots).filter(row => row && row.market && row.lot).map(row => {
    const option = options.find(item => item.market === row.market && item.lot === row.lot &&
      (!row.pack || item.pack === row.pack))
    const packaging = option?.packaging ?? choosePackagingForLot(products, row.lot, row.market).packaging
    const unit = normalizeUnit(row.unit)
    const available = toFiniteNumber(row.available)
    const conversion = packaging && unit && available !== null
      ? packaging.convert(available, unit, KIT)
      : { ok: false, quantity: null, reason: '缺少包装资料或数量' }
    const replacement = row.replacement && typeof row.replacement === 'object'
      ? normalizeReplacement(row.replacement, products, row.market)
      : null
    return {
      market: row.market,
      lot: String(row.lot),
      pack: row.pack ? String(row.pack) : option?.pack ?? null,
      available,
      unit,
      availableKits: conversion.ok ? conversion.quantity : null,
      conversion: conversion.ok ? null : conversion.reason,
      packaging,
      replacement,
      raw: row
    }
  })
}

function normalizeReplacement(replacement, products, market) {
  const unit = normalizeUnit(replacement.unit ?? KIT)
  const oldLot = replacement.old ? String(replacement.old) : null
  const oldPack = replacement.oldPack ? String(replacement.oldPack) : null
  const chosen = oldLot
    ? chooseProduct(products, { pack: oldPack, market, lot: oldLot })
    : { packaging: null, product: null }
  const units = toFiniteNumber(replacement.units)
  const conversion = chosen.packaging && units !== null
    ? chosen.packaging.convert(units, unit, KIT)
    : null
  return {
    old: oldLot,
    oldPack,
    units,
    unit,
    unitsKits: conversion?.ok ? conversion.quantity : (unit === KIT ? units : null),
    effectiveBatch: replacement.effectiveBatch ? String(replacement.effectiveBatch) : null,
    fromUnreservedOnly: replacement.fromUnreservedOnly === true,
    partial: replacement.effectiveBatch !== null && replacement.effectiveBatch !== undefined,
    packaging: chosen.packaging,
    raw: replacement
  }
}

export function normalizeInquiries(inquiries, options) {
  return asArray(inquiries).filter(row => row && row.id).map(row => {
    const market = row.market ? String(row.market) : null
    const original = row.lot
      ? {
          market,
          lot: String(row.lot),
          pack: row.pack ? String(row.pack) : null,
          quoteId: row.quote ? String(row.quote) : null,
          source: 'inquiry-snapshot',
          current: false
        }
      : null
    const option = original
      ? options.find(item => item.market === original.market && item.lot === original.lot &&
          (!original.pack || item.pack === original.pack))
      : options.find(item => item.market === market)
    const packaging = option?.packaging ?? (row.pack
      ? chooseProduct(productsFromOptions(options), { pack: String(row.pack), lot: row.lot ?? null }).packaging
      : null)
    const sku = row.sku ? String(row.sku) : option?.sku ?? null
    const amount = toFiniteNumber(row.quantity)
    const unit = normalizeUnit(row.unit ?? KIT)
    // The buyer states the required number of kits.  If the inquiry records
    // another unit the packaging must be able to convert it; otherwise the
    // required kit count is unknown and must not be guessed.
    const kits = requestedKits(amount, unit, packaging)
    return {
      id: String(row.id),
      sku,
      market,
      quantity: amount,
      unit,
      requiredKits: kits.ok ? kits.kits : null,
      quantityError: kits.ok ? null : kits.reason,
      signed: row.signed === true,
      state: row.signed === true ? 'confirmed' : 'unconfirmed',
      original: original ? {
        ...original,
        sku,
        packaging
      } : null,
      raw: row
    }
  })
}

/** Rebuild a minimal product list from normalised options (for packaging). */
function productsFromOptions(options) {
  const seen = new Map()
  for (const option of options) {
    if (!option.packaging || !option.pack) continue
    if (seen.has(option.pack)) continue
    seen.set(option.pack, {
      sku: option.sku ?? option.packaging.sku ?? null,
      pack: option.pack,
      market: option.market ?? option.packaging.market ?? null,
      lot: option.lot ?? option.packaging.lot ?? null,
      tree: option.packaging.tree,
      packaging: option.packaging
    })
  }
  return [...seen.values()]
}

/**
 * Warehouse pools and reservations.
 *
 * A pool is a physical stock position.  Its `markets` list is the only
 * evidence that two destination options quote the same stock; lot numbers
 * alone are not enough.  Only reservations explicitly marked confirmed count,
 * and a receipt superseded by another receipt is never counted twice.
 */
export function buildWarehouse(snapshot, products) {
  const raw = snapshot.warehouse && typeof snapshot.warehouse === 'object'
    ? snapshot.warehouse
    : {}
  const anomalies = []
  const poolRows = new Map()
  for (const row of asArray(raw.pools)) {
    if (!row?.id) {
      anomalies.push({ code: 'pool-without-id', message: '仓池缺少编号', row })
      continue
    }
    const id = String(row.id)
    if (poolRows.has(id)) {
      anomalies.push({
        code: 'duplicate-pool',
        message: `仓池 ${id} 在同一次仓库资料中重复出现`,
        previous: poolRows.get(id).raw,
        row
      })
      continue
    }
    const unit = normalizeUnit(row.unit)
    const stock = toFiniteNumber(row.physicalStock)
    const packaging = row.lot
      ? choosePackagingForLot(products, String(row.lot)).packaging
      : null
    const conversion = packaging && unit && stock !== null
      ? packaging.convert(stock, unit, KIT)
      : { ok: false, quantity: null, reason: '仓池批号没有唯一包装资料' }
    poolRows.set(id, {
      id,
      lot: row.lot ? String(row.lot) : null,
      markets: asArray(row.markets).map(String),
      unit,
      physicalStock: stock,
      physicalKits: conversion.ok ? conversion.quantity : null,
      conversion: conversion.ok ? null : conversion.reason,
      packaging,
      raw: row
    })
  }

  const receiptIndex = new Map()
  for (const row of asArray(raw.reservations)) {
    if (!row?.receipt) {
      anomalies.push({ code: 'reservation-without-receipt', message: '预留行没有确认编号', row })
      continue
    }
    const receipt = String(row.receipt)
    const reservation = normalizeReservation(row, products, poolRows)
    if (!receiptIndex.has(receipt)) receiptIndex.set(receipt, [])
    receiptIndex.get(receipt).push(reservation)
  }
  // A receipt repeated with conflicting content is kept once (confirmed wins).
  const deduped = []
  for (const [receipt, rows] of receiptIndex) {
    if (rows.length === 1) {
      deduped.push(rows[0])
      continue
    }
    anomalies.push({
      code: 'duplicate-receipt',
      message: `确认编号 ${receipt} 出现多行，只按一行计入`,
      receipts: [receipt],
      rows: rows.map(row => row.raw)
    })
    const chosen = rows.find(row => row.state === 'confirmed') ?? rows[0]
    deduped.push({ ...chosen, duplicates: rows.length })
  }

  // A confirmed replacement receipt invalidates the receipt it replaces even
  // if the older line still claims to be confirmed.
  const replaced = new Map()
  for (const row of deduped) {
    if (!row.replacesReceipt) continue
    if (row.state === 'confirmed') replaced.set(row.replacesReceipt, row.receipt)
  }
  const reservations = deduped.map(row => {
    const replacementReceipt = replaced.get(row.receipt)
    const state = replacementReceipt ? 'superseded' : row.state
    return {
      ...row,
      state,
      supersededBy: replacementReceipt ?? row.supersededBy ?? null,
      active: state === 'confirmed'
    }
  })

  for (const [receipt, replacementReceipt] of replaced) {
    if (!reservations.some(row => row.receipt === receipt)) {
      anomalies.push({
        code: 'replacement-without-previous-receipt',
        message: `确认 ${replacementReceipt} 声明替换 ${receipt}，但仓库没有列出原确认`,
        receipts: [receipt, replacementReceipt]
      })
    }
  }

  const openingPools = []
  for (const row of asArray(raw.reservations)) {
    if (!row?.pool) continue
    openingPools.push(String(row.pool))
  }
  const poolIds = new Set(poolRows.keys())
  for (const id of openingPools) {
    if (!poolIds.has(id)) {
      anomalies.push({
        code: 'reservation-with-unknown-pool',
        message: `预留行指到未列出的仓池 ${id}，该仓池不能用于折算可用量`,
        pool: id
      })
    }
  }
  const pools = [...poolRows.values()].map(pool => {
    const lines = reservations.filter(row => row.pool === pool.id)
    const active = lines.filter(row => row.active)
    const reservedKits = roundQuantity(active.reduce((total, row) =>
      total + (row.kits ?? 0), 0))
    const reservedRaw = active.reduce((total, row) => total + (row.quantity ?? 0), 0)
    const physicalKits = pool.physicalKits
    const unreservedKits = physicalKits === null
      ? null
      : roundQuantity(Math.max(0, physicalKits - reservedKits))
    const overReserved = physicalKits !== null && reservedKits > physicalKits
    if (overReserved) {
      anomalies.push({
        code: 'pool-over-reserved',
        message: `仓池 ${pool.id} 的有效预留超过实物库存，超出 ${roundQuantity(reservedKits - physicalKits)} 个组件`,
        pool: pool.id,
        physicalKits,
        reservedKits
      })
    }
    if (pool.conversion) {
      anomalies.push({
        code: 'pool-not-convertible',
        message: `仓池 ${pool.id}（批号 ${pool.lot ?? '?'}）无法换算成组件数：${pool.conversion}；该池不计入可交量`,
        pool: pool.id,
        lot: pool.lot,
        reason: pool.conversion
      })
    }
    for (const row of active) {
      if (row.kits === null && !lines.some(line => line.conversion)) {
        anomalies.push({
          code: 'reservation-not-convertible',
          message: `确认 ${row.receipt} 的预留数量无法按 ${row.pack ?? row.lot ?? '?'} 的包装折算`,
          receipt: row.receipt,
          reason: row.conversion
        })
      }
    }
    return {
      ...pool,
      reservations: lines.map(summarizeReservation),
      activeReservations: active.map(summarizeReservation),
      reservedKits,
      reservedRaw,
      unreservedKits,
      overReserved,
      sources: []
    }
  })

  return { pools, reservations, anomalies, replacedReceipts: replaced }
}

function normalizeReservation(row, products, poolRows) {
  const pool = row.pool ? String(row.pool) : null
  const pack = row.pack ? String(row.pack) : null
  const lot = row.lot ? String(row.lot) : null
  const inquiry = row.inquiry ? String(row.inquiry) : null
  const unit = normalizeUnit(row.unit)
  const qty = toFiniteNumber(row.qty)
  const chosen = pack
    ? chooseProduct(products, { pack, lot })
    : lot ? choosePackagingForLot(products, lot) : { packaging: null }
  const packaging = chosen.packaging ?? null
  const conversion = packaging && unit && qty !== null
    ? packaging.convert(qty, unit, KIT)
    : { ok: false, quantity: null, reason: '预留行缺少包装资料' }
  const state = row.state ? String(row.state) : 'unconfirmed'
  return {
    receipt: String(row.receipt),
    inquiry,
    pool,
    lot,
    pack,
    unit,
    quantity: qty,
    kits: conversion.ok ? conversion.quantity : null,
    conversion: conversion.ok ? null : conversion.reason,
    packaging,
    state: state === 'confirmed' ? 'confirmed' : state,
    replacesReceipt: row.replacesReceipt ? String(row.replacesReceipt) : null,
    raw: row,
    poolEntry: pool ? poolRows.get(pool) ?? null : null
  }
}

function summarizeReservation(row) {
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

export function buildCatalog(snapshot) {
  const products = normalizeProducts(snapshot.products)
  const destination = buildMarketOptions(snapshot, products)
  const history = buildHistoricalOptions(snapshot, products)
  const allOptions = [...destination.options, ...history]
  const lots = normalizeLots(snapshot.lots, products, allOptions)
  const inquiries = normalizeInquiries(snapshot.inquiries, allOptions)
  const warehouse = buildWarehouse(snapshot, products)

  const skus = new Map()
  for (const option of allOptions) {
    if (!option.sku) continue
    if (!skus.has(option.sku)) {
      skus.set(option.sku, { sku: option.sku, options: [], markets: new Set(), packs: new Set() })
    }
    const entry = skus.get(option.sku)
    entry.options.push(option)
    entry.markets.add(option.market)
    if (option.pack) entry.packs.add(option.pack)
  }
  for (const entry of skus.values()) {
    entry.markets = [...entry.markets].sort()
    entry.packs = [...entry.packs].sort()
    entry.mergedAcrossMarkets = entry.markets.length > 1
    entry.termsFollowMarket = true
  }

  const currentOptions = allOptions.filter(option => option.current)
  const unlinked = []
  for (const option of allOptions) {
    const linked = warehouse.pools.filter(pool => pool.lot === option.lot &&
      pool.markets.includes(option.market))
    if (!linked.length && option.current) {
      unlinked.push({
        option: option.key,
        market: option.market,
        lot: option.lot,
        pack: option.pack,
        reason: '仓库没有明确声明该市场可用的仓池；不能按批号自行合账'
      })
    }
  }

  return {
    products,
    options: allOptions,
    currentOptions,
    historyOptions: history,
    lots,
    inquiries,
    warehouse,
    skus: [...skus.values()],
    warnings: [...destination.warnings, ...warehouse.anomalies.map(anomaly => ({
      code: anomaly.code,
      message: anomaly.message,
      anomaly
    }))],
    unlinkedOptions: unlinked,
    byInquiry: new Map(inquiries.map(inquiry => [inquiry.id, inquiry])),
    bySku: skus
  }
}

/** Pools explicitly available to a market/lot pair, deduplicated by pool id. */
export function poolsFor(catalog, market, lot) {
  return catalog.warehouse.pools.filter(pool =>
    pool.lot === lot && pool.markets.includes(market))
}

export function reservationsFor(catalog, inquiryId) {
  return catalog.warehouse.reservations.filter(row =>
    row.inquiry === inquiryId && row.active)
}

export function optionCandidatesFor(catalog, inquiry) {
  const candidates = []
  const add = option => {
    if (!option) return
    if (candidates.some(existing => existing.key === option.key ||
      (existing.market === option.market && existing.lot === option.lot &&
        existing.pack === option.pack && existing.quoteId === option.quoteId))) return
    candidates.push(option)
  }
  for (const option of catalog.currentOptions.filter(option => option.market === inquiry.market)) {
    add(option)
  }
  if (inquiry.original) {
    const known = catalog.options.find(option =>
      option.market === inquiry.original.market &&
      option.lot === inquiry.original.lot &&
      (!inquiry.original.pack || option.pack === inquiry.original.pack))
    if (known) add({ ...known, source: 'inquiry-snapshot', current: false })
    else add({
      ...inquiry.original,
      key: key(inquiry.original.market, inquiry.original.sku, inquiry.original.lot,
        inquiry.original.pack, inquiry.original.quoteId),
      packaging: inquiry.original.packaging,
      identity: { sku: inquiry.original.sku, matchedBy: 'inquiry-snapshot', merged: true }
    })
  }
  // A declared replacement tells us the old option even after the old page
  // has been replaced by a newer lot.
  for (const lotRow of catalog.lots.filter(row => row.market === inquiry.market &&
    row.replacement?.old)) {
    if (inquiry.original?.lot && inquiry.original.lot !== lotRow.replacement.old) continue
    const old = replacementOption(catalog.lots, catalog.products, inquiry.market, lotRow.replacement)
    if (old) {
      const existing = catalog.options.find(option => option.market === old.market &&
        option.lot === old.lot && (!old.pack || option.pack === old.pack))
      add(existing ? { ...existing, current: false, source: 'historical-quote' } : old)
    }
  }
  return candidates
}

export function optionForLot(catalog, market, lot) {
  return catalog.currentOptions.find(option => option.market === market && option.lot === lot) ??
    catalog.options.find(option => option.market === market && option.lot === lot) ?? null
}

export function lotRow(catalog, market, lot) {
  return catalog.lots.find(row => row.market === market && row.lot === lot) ?? null
}

export function replacementForLot(catalog, market, lot) {
  return lotRow(catalog, market, lot)?.replacement ?? null
}

export function packagingFingerprint(packaging) {
  return packaging?.fingerprint ?? null
}

export function samePackaging(left, right) {
  return packagesHaveSameTree(left, right)
}

export function summarizePool(pool) {
  return {
    id: pool.id,
    lot: pool.lot,
    unit: pool.unit,
    physicalStock: pool.physicalStock,
    physicalKits: pool.physicalKits,
    reservedKits: pool.reservedKits,
    unreservedKits: pool.unreservedKits,
    markets: [...pool.markets],
    sharedByMarkets: pool.markets.length > 1,
    conversion: pool.conversion,
    sources: pool.sources,
    reservations: pool.activeReservations,
    supersededReservations: pool.reservations.filter(row => row.state === 'superseded'),
    overReserved: pool.overReserved
  }
}

export function attachPoolSources(catalog) {
  for (const pool of catalog.warehouse.pools) {
    pool.sources = catalog.options.filter(option =>
      option.lot === pool.lot && pool.markets.includes(option.market))
      .map(option => ({
        market: option.market,
        sku: option.sku,
        pack: option.pack,
        lot: option.lot,
        quoteId: option.quoteId,
        current: option.current,
        link: POOL_LINK_MARKET
      }))
  }
  return catalog
}

export function ensureCatalog(snapshot) {
  return attachPoolSources(buildCatalog(snapshot))
}

export { KIT, normalizeUnit, nonNegativeInteger, roundQuantity, unique }
