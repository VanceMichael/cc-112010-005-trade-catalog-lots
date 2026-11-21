/**
 * Collector orchestration.
 *
 * One `collect()` produces a complete, self-contained answer:
 *   1. read the destination pages, wholesale catalogue, lots, inquiries and
 *      warehouse;
 *   2. merge them into a catalogue that refuses unsafe identity merges;
 *   3. look up every quote combination the inquiries need;
 *   4. analyse each inquiry and produce a pool ledger showing who competes for
 *      which physical stock.
 *
 * The collector is stateful on purpose: a later release may remove an old
 * destination page or an old packaging definition while a confirmed inquiry
 * still has to be interpreted with the terms that applied when it was signed.
 * Remembered data is never treated as current – it only resolves historical
 * lots/packs and already-observed quote ids.
 */

import {
  ensureCatalog,
  normalizeProducts,
  revisionKey
} from './model.mjs'
import { SourceClient, fetchQuotes } from './source-client.mjs'
import { analyzeAll, analyzeInquiry, inquiryReport, planQuoteRequests } from './analysis.mjs'
import { key, roundQuantity, sum } from './util.mjs'

function quoteId(record) {
  return record?.state === 'published' && record.body?.id ? String(record.body.id) : null
}

export class Collector {
  constructor(options = {}) {
    this.client = options.client ?? new SourceClient(options.origin ?? options.url, options)
    this.remember = options.remember !== false
    this.maxRemembered = options.maxRemembered ?? 5000
    this.clock = options.clock ?? (() => new Date())
    this.productHistory = new Map()
    this.optionHistory = new Map()
    this.quoteHistory = new Map()
    this.quoteById = new Map()
    this.lastStep = null
  }

  get origin() {
    return this.client.origin
  }

  rememberProduct(product) {
    const id = revisionKey(product)
    this.productHistory.set(id, product)
    this.trim(this.productHistory)
  }

  rememberOption(option) {
    if (!option.lot || !option.market) return
    const id = revisionKey(option)
    this.optionHistory.set(id, {
      market: option.market,
      sku: option.sku,
      lot: option.lot,
      pack: option.pack,
      quoteId: option.quoteId ?? null,
      title: option.title ?? null,
      href: option.href ?? null,
      source: 'observed-history'
    })
    this.trim(this.optionHistory)
  }

  rememberQuote(quote, request) {
    if (!request) return
    const id = [request.market, request.lot, request.quantity].join('|')
    const entry = {
      ...quote,
      market: request.market,
      lot: request.lot,
      quantity: request.quantity,
      observedAt: this.clock().toISOString?.() ?? String(this.clock())
    }
    const existing = this.quoteHistory.get(id)
    // A published observation always beats a pending one; a pending result
    // never erases an earlier publication for the same combination.
    if (!existing || quote.state === 'published' || existing.state !== 'published') {
      this.quoteHistory.set(id, entry)
    }
    const idOfQuote = quoteId(quote)
    if (idOfQuote) this.quoteById.set(idOfQuote, entry)
    this.trim(this.quoteHistory)
    this.trim(this.quoteById)
  }

  trim(map) {
    while (map.size > this.maxRemembered) {
      const oldest = map.keys().next().value
      map.delete(oldest)
    }
  }

  /** Merge freshly observed data with history for historical interpretation. */
  buildSnapshot(snapshot) {
    const products = new Map()
    for (const product of this.productHistory.values()) {
      products.set(revisionKey(product), product)
    }
    for (const product of snapshot.products) {
      products.set(revisionKey(product), product)
    }

    const currentOptions = new Set(snapshot.markets.flatMap(page => page.articles.map(article =>
      revisionKey({
        market: article.market,
        sku: article.sku,
        lot: article.lot,
        pack: article.pack,
        quoteId: article.quote
      }))))
    const historyOptions = [...this.optionHistory.values()].filter(option =>
      !currentOptions.has(revisionKey(option)))
      .filter(option => !snapshot.historyOptions?.some(existing =>
        revisionKey(existing) === revisionKey(option)))

    const quotes = {}
    for (const [id, record] of this.quoteHistory) {
      if (!(id in quotes)) quotes[id] = record
    }

    return {
      ...snapshot,
      products: [...products.values()],
      historyOptions: [...(snapshot.historyOptions ?? []), ...historyOptions],
      rememberedQuotes: quotes
    }
  }

  async collect(options = {}) {
    this.client.quoteCache.clear()
    const snapshot = this.buildSnapshot(await this.client.snapshot(options))
    const catalog = ensureCatalog(snapshot)

    if (this.remember) {
      for (const product of catalog.products) this.rememberProduct(product.raw)
      for (const page of snapshot.markets) {
        for (const article of page.articles) {
          if (!article.market || !article.lot) continue
          this.rememberOption({
            market: article.market,
            sku: article.sku,
            lot: article.lot,
            pack: article.pack,
            quoteId: article.quote,
            title: article.title ?? page.title,
            href: article.href ?? page.href
          })
        }
      }
    }

    const requests = planQuoteRequests(catalog)
    const fresh = await fetchQuotes(this.client, requests, options.quoteOptions ?? {})
    const quotes = { ...snapshot.rememberedQuotes, ...fresh }

    if (this.remember) {
      for (const request of requests) {
        const id = [request.market, request.lot, request.quantity].join('|')
        const record = quotes[id]
        if (record) this.rememberQuote(record, request)
      }
    }

    const { analyses, allocation } = analyzeAll(catalog, quotes)
    const ledger = buildPoolLedger(catalog, analyses, allocation)
    const step = options.step ?? null
    if (Number.isInteger(step)) this.lastStep = step

    return {
      ok: true,
      origin: this.origin,
      step,
      fetchedAt: snapshot.fetchedAt,
      counts: {
        markets: snapshot.markets.length,
        options: catalog.currentOptions.length,
        products: catalog.products.length,
        inquiries: catalog.inquiries.length,
        pools: catalog.warehouse.pools.length,
        quotesRequested: requests.length,
        quotesPublished: requests.filter(request => {
          const id = [request.market, request.lot, request.quantity].join('|')
          return quotes[id]?.state === 'published'
        }).length
      },
      inquiries: analyses,
      poolLedger: ledger,
      pools: catalog.warehouse.pools.map(pool => pool.id),
      warnings: [...catalog.warnings, ...ledger.anomalies],
      unlinkedOptions: catalog.unlinkedOptions,
      catalog: options.includeCatalog ? catalog : undefined
    }
  }

  /**
   * Replay every release from `from` (default 0) up to `to`, remembering
   * historical packaging/options/quotes, and return only the final answer.
   *
   * A later release only lists changed sources.  A destination page that was
   * replaced may no longer carry the old pack, so a fresh process that jumps
   * straight to release N cannot interpret an older confirmed reservation.
   * Warm-up reproduces the observations a continuously running collector
   * would have made.
   */
  async collectRange(to, options = {}) {
    if (!Number.isInteger(to) || to < 0) throw new Error('发布序号必须是非负整数')
    const from = Number.isInteger(options.from) ? options.from : 0
    if (from > to) throw new Error('起始发布序号不能大于目标发布序号')
    let result = null
    for (let step = from; step <= to; step++) {
      const final = step === to
      result = await this.collect({
        ...options,
        step,
        includeCatalog: final ? options.includeCatalog : false,
        quoteOptions: final ? options.quoteOptions : { ...(options.quoteOptions ?? {}), cache: false }
      })
    }
    result.warmup = { from, to: to - 1, steps: Math.max(0, to - from) }
    return result
  }

  async collectInquiry(inquiryId, options = {}) {
    const result = Number.isInteger(options.from)
      ? await this.collectRange(options.step, options)
      : await this.collect(options)
    const analysis = result.inquiries.find(item => item.inquiry?.id === inquiryId)
    return {
      ...result,
      inquiry: analysis ?? null,
      report: analysis ? inquiryReport(analysis) : null
    }
  }

  /** Re-price an unconfirmed inquiry after a release without touching the rest. */
  async analyze(inquiryId, options = {}) {
    const result = Number.isInteger(options.from)
      ? await this.collectRange(options.step, options)
      : await this.collect(options)
    const analysis = result.inquiries.find(item => item.inquiry?.id === inquiryId)
    if (!analysis) throw new Error(`没有询价 ${inquiryId}`)
    return { analysis, report: inquiryReport(analysis), ledger: result.poolLedger }
  }
}

/**
 * Physical stock per pool, reservations per inquiry, and the unconfirmed
 * demands that would draw on the same unreserved remainder.  This is the
 * evidence a buyer needs to see why two same-pool inquiries cannot both copy
 * each other's deliverable number.
 */
export function buildPoolLedger(catalog, analyses, allocation = null) {
  const anomalies = []
  const ledger = catalog.warehouse.pools.map(pool => {
    const active = catalog.warehouse.reservations.filter(row =>
      row.pool === pool.id && row.active)
    const byInquiry = new Map()
    for (const row of active) {
      if (!row.inquiry) continue
      if (!byInquiry.has(row.inquiry)) {
        byInquiry.set(row.inquiry, { inquiry: row.inquiry, receipts: [], kits: 0, lines: [] })
      }
      const entry = byInquiry.get(row.inquiry)
      entry.receipts.push(row.receipt)
      entry.kits = roundQuantity(entry.kits + (row.kits ?? 0))
      entry.lines.push({
        receipt: row.receipt,
        lot: row.lot,
        pack: row.pack,
        unit: row.unit,
        quantity: row.quantity,
        kits: row.kits,
        replacesReceipt: row.replacesReceipt
      })
    }

    const claims = []
    for (const analysis of analyses) {
      if (!analysis.ok) continue
      const involved = analysisInvolvesPool(analysis, pool.id)
      if (!involved) continue
      const own = byInquiry.get(analysis.inquiry.id)
      const planned = allocation?.byInquiry?.get(analysis.inquiry.id)
      const currentPlanned = planned?.current?.unreservedPools?.[pool.id] ?? 0
      const ownPlanned = planned?.current?.ownPools?.[pool.id] ?? 0
      const oldPlanned = (planned?.old ?? []).reduce((total, share) =>
        total + (share.pools?.[pool.id] ?? 0), 0)
      // Uncovered demand: the current option wants this pool but the plan
      // could not allocate it.  Old-share demand is not added here because
      // it is only ever convertible out of the same unreserved remainder.
      const currentOptionPools = analysis.governing?.pools?.map(item => item.id) ?? []
      const plannedEntry = planned?.current ?? null
      // Need is independent of whether a quote exists yet: a pending market
      // quote still creates demand on the pool and must show up as contention.
      const ownReservedKits = involved.ownReservedKits ?? 0
      const needKits = analysis.inquiry.signed
        ? (own?.kits ?? 0)
        : currentOptionPools.includes(pool.id)
          ? roundQuantity(Math.max(0, (analysis.inquiry.requiredKits ?? 0) - ownReservedKits))
          : 0
      const capacityKits = plannedEntry?.quote?.saleUnitKits &&
        Number.isFinite(plannedEntry?.capacityPackages)
        ? roundQuantity(plannedEntry.capacityPackages * plannedEntry.quote.saleUnitKits)
        : 0
      claims.push({
        inquiry: analysis.inquiry.id,
        market: analysis.inquiry.market,
        signed: analysis.inquiry.signed,
        ownKits: involved.ownKits,
        ownReservedKits,
        requiredKits: analysis.inquiry.requiredKits,
        needKits,
        capacityKits,
        plannedKits: roundQuantity(currentPlanned),
        plannedOwnKits: roundQuantity(ownPlanned),
        plannedOldKits: roundQuantity(oldPlanned),
        plannedTotalKits: roundQuantity(currentPlanned + ownPlanned + oldPlanned),
        receipts: own?.receipts ?? [],
        status: involved.status
      })
    }

    const unreserved = roundQuantity(pool.unreservedKits ?? 0)
    const needTotal = roundQuantity(sum(claims
      .filter(claim => !claim.signed)
      .map(claim => claim.needKits)))
    const plannedTotal = roundQuantity(sum(claims
      .filter(claim => !claim.signed)
      .map(claim => claim.plannedTotalKits)))
    const ownReservedTotal = roundQuantity(sum(claims
      .map(claim => claim.ownKits)))
    // Capacity available to unconfirmed demand is the unreserved remainder.
    // Need beyond that is contention; own confirmed reservations are not
    // available to anyone else and are not added to demand.  A pool that
    // cannot be converted is reported separately, not as contention.
    const contention = pool.physicalKits !== null && needTotal > unreserved
    const unplanned = roundQuantity(Math.max(0, needTotal - plannedTotal))
    if (contention) {
      anomalies.push({
        code: 'shared-pool-contention',
        message: `仓池 ${pool.id} 的未预留份额 ${unreserved} 个组件不足以同时满足 ${claims
          .filter(claim => !claim.signed && claim.needKits > 0)
          .map(claim => claim.inquiry).join('、')} 的需求 ${needTotal} 个组件；同池来源不能各占一遍库存`,
        pool: pool.id,
        unreservedKits: unreserved,
        demandKits: needTotal,
        claims
      })
    }

    return {
      id: pool.id,
      lot: pool.lot,
      unit: pool.unit,
      physicalStock: pool.physicalStock,
      physicalKits: pool.physicalKits,
      markets: [...pool.markets],
      sharedByMarkets: pool.markets.length > 1,
      reservedKits: pool.reservedKits,
      unreservedKits: unreserved,
      convertible: pool.physicalKits !== null,
      conversionError: pool.conversion ?? null,
      reservations: [...byInquiry.values()],
      claims,
      demandKits: needTotal,
      plannedKits: plannedTotal,
      ownReservedKits: ownReservedTotal,
      unplannedKits: unplanned,
      contention,
      allocationBasis: '按来源顺序分配未预留份额，仅为证据，不是仓库确认',
      supersededReceipts: catalog.warehouse.reservations
        .filter(row => row.pool === pool.id && row.state === 'superseded')
        .map(row => row.receipt)
    }
  })
  return {
    pools: ledger,
    anomalies,
    totalPhysicalKits: roundQuantity(sum(ledger.map(pool => pool.physicalKits ?? 0))),
    totalReservedKits: roundQuantity(sum(ledger.map(pool => pool.reservedKits ?? 0))),
    allocation: allocation ? {
      order: allocation.order,
      remainingAfterPlanning: allocation.remainingAfterPlanning
    } : null
  }
}

function analysisInvolvesPool(analysis, poolId) {
  const governing = analysis.governing
  const governingPool = governing?.pools?.find(pool => pool.id === poolId)
  if (governingPool) {
    const allocationPools = analysis.evidence?.allocation?.current?.pools ?? {}
    const ownReceipts = analysis.evidence?.reservations ?? []
    const ownKits = analysis.inquiry.signed
      ? ownReceipts.filter(row => row.pool === poolId && row.state === 'confirmed')
          .reduce((total, row) => total + (row.kits ?? 0), 0)
      : ownReceipts.filter(row => row.pool === poolId && row.state === 'confirmed')
          .reduce((total, row) => total + (row.kits ?? 0), 0)
    return {
      ownKits,
      ownReservedKits: ownKits,
      plannedKits: allocationPools[poolId] ?? 0,
      status: governing.status
    }
  }
  const share = (analysis.oldShares ?? []).find(item =>
    item.pools?.some(pool => pool.id === poolId))
  if (share) return { ownKits: 0, ownReservedKits: 0, plannedKits: 0, status: 'old-share' }
  const allocationOld = (analysis.evidence?.allocation?.old ?? [])
    .some(item => Object.hasOwn(item.pools ?? {}, poolId))
  if (allocationOld) return { ownKits: 0, ownReservedKits: 0, plannedKits: 0, status: 'old-share' }
  return null
}

/** Convenience helper for scripts: collect one point-in-time answer. */
export async function collectSnapshot(options = {}) {
  const collector = new Collector(options)
  const collectOptions = options.collectOptions ?? {
    step: options.step,
    includeCatalog: options.includeCatalog,
    selectorHtml: options.selectorHtml,
    products: options.products,
    lots: options.lots,
    inquiries: options.inquiries,
    warehouse: options.warehouse
  }
  return collector.collect(collectOptions)
}

export { collectSnapshot as collect }
export { analyzeInquiry, inquiryReport, key, normalizeProducts }
