import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { makeSource } from '../source.mjs'
import { Collector, collect } from '../src/collector.mjs'
import { buildPackageModel } from '../src/packaging.mjs'
import { ensureCatalog } from '../src/model.mjs'
import {
  analyzeAll,
  analyzeInquiry,
  inquiryReport,
  normalizeQuote
} from '../src/analysis.mjs'
import { requestedKits } from '../src/units.mjs'

async function openServer(t) {
  const server = makeSource()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return 'http://127.0.0.1:' + server.address().port
}

const TH_PACK = [
  { id: 'pallet', child: 'box', n: 8 },
  { id: 'box', child: 'kit', n: 4 },
  { id: 'kit', child: 'part', n: 3, splittable: false }
]

test('包装图只在可拆售的边之间换算', () => {
  const packaging = buildPackageModel(TH_PACK)
  assert.equal(packaging.factorTo('pallet', 'kit'), 32)
  assert.equal(packaging.factorTo('box', 'kit'), 4)
  assert.equal(packaging.convert(2, 'pallet', 'kit').quantity, 64)
  assert.equal(packaging.convert(64, 'kit', 'pallet').quantity, 2)
  // The kit→part edge is sealed: a single part may not be sold.
  assert.equal(packaging.isSellable('kit'), true)
  assert.equal(packaging.isSellable('part'), false)
  const blocked = packaging.convert(1, 'kit', 'part')
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /不可拆售/)
  assert.equal(packaging.unitInfo('part').sellable, false)
})

test('整托、整盒与不可拆售套件分别按各自包装计价', () => {
  const oneBox = buildPackageModel([{ id: 'box', child: 'kit', n: 5 }])
  const quote = normalizeQuote({
    state: 'published',
    status: 200,
    body: { id: 'Q', saleUnit: 'box', min: 10, maximum: 15 }
  }, oneBox)
  assert.equal(quote.convertible, true)
  assert.equal(quote.saleUnitKits, 5)

  const sealed = buildPackageModel([
    { id: 'kit', child: 'part', n: 3, splittable: false }
  ])
  const partQuote = normalizeQuote({
    state: 'published',
    status: 200,
    body: { id: 'Q2', saleUnit: 'part', min: 1 }
  }, sealed)
  assert.equal(partQuote.sellable, false)
  assert.equal(partQuote.convertible, false)
})

test('买家按组件数填写需求，其他单位须经包装换算', () => {
  const packaging = buildPackageModel(TH_PACK)
  assert.deepEqual(requestedKits(64, 'kit', packaging), { ok: true, kits: 64, unit: 'kit' })
  assert.deepEqual(requestedKits(2, 'pallet', packaging), { ok: true, kits: 64, unit: 'pallet' })
  assert.equal(requestedKits(1, 'part', packaging).ok, false)
})

test('第 0 次发布：已确认单按自己的预留解释，未确认单按需求整包装交货', async t => {
  const origin = await openServer(t)
  const result = await collect({ origin, step: undefined })
  const byId = new Map(result.inquiries.map(analysis => [analysis.inquiry.id, analysis]))

  const signed = byId.get('I-7')
  assert.equal(signed.inquiry.signed, true)
  assert.equal(signed.governing.deliverable.kits, 32)
  assert.equal(signed.governing.deliverable.unit, 'pallet')
  assert.equal(signed.governing.gap.kits, 32)
  assert.equal(signed.governing.replacementConfirmation.received, false)

  // 64 kits need two pallets; the collector must not ship all four.
  const th = byId.get('I-9')
  assert.equal(th.governing.deliverable.kits, 64)
  assert.equal(th.governing.deliverable.quantity, 2)
  assert.equal(th.governing.stock.unreservedKits, 96)
  assert.equal(th.evidence.deliveryTerms.min, 2)
  assert.equal(th.evidence.deliveryTerms.delivery, '提货')

  const jp = byId.get('I-10')
  assert.equal(jp.governing.deliverable.unit, 'box')
  assert.equal(jp.governing.deliverable.quantity, 13)
  assert.equal(jp.governing.deliverable.kits, 65)

  // VN has no warehouse pool declared for B8 at this release.
  const vn = byId.get('I-12')
  assert.equal(vn.status, 'no-pool')
  assert.ok(vn.pending.some(item => item.code === 'no-applicable-pool'))
})

test('第 1 次发布：同池两个市场共用一份未预留份额，旧批份额受限', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  await collector.collect({ step: 0 })
  const result = await collector.collect({ step: 1, includeCatalog: true })
  const byId = new Map(result.inquiries.map(analysis => [analysis.inquiry.id, analysis]))

  // W8 is declared for TH and VN; neither may count the 72 kits twice.
  const w8 = result.poolLedger.pools.find(pool => pool.id === 'W8')
  assert.deepEqual(w8.markets, ['TH', 'VN'])
  assert.equal(w8.unreservedKits, 72)
  assert.equal(w8.demandKits, 112)
  assert.equal(w8.contention, true)
  assert.ok(result.poolLedger.anomalies.some(item => item.code === 'shared-pool-contention'))

  const th = byId.get('I-9')
  const vn = byId.get('I-12')
  assert.ok(th.sharedPoolPeers.some(peer => peer.inquiry === 'I-12'))
  assert.ok(vn.sharedPoolPeers.some(peer => peer.inquiry === 'I-9'))
  // Each inquiry reports its own demand, not the peer's.
  assert.equal(th.inquiry.requiredKits, 64)
  assert.equal(vn.inquiry.requiredKits, 48)

  // TH still has no published B8 price at this release.
  assert.equal(th.governing.status, 'quote-pending')
  assert.ok(th.pending.some(item => item.code === 'market-quote-pending'))

  // The B7 old lot may only convert unreserved stock; TH-W1 is fully reserved.
  const oldShare = th.oldShares.find(share => share.option.lot === 'B7')
  assert.ok(oldShare)
  assert.equal(oldShare.option.quoteId, 'W-1')
  assert.equal(oldShare.declaredKits, 32)
  assert.equal(oldShare.deliverable.kits, 0)
  assert.ok(oldShare.blockers.some(reason => /未预留/.test(reason)))
})

test('第 2 次发布：新包装与最低订量不足时列出旧份额和缺口', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  await collector.collect({ step: 0 })
  await collector.collect({ step: 1 })
  const result = await collector.collect({ step: 2 })
  const th = result.inquiries.find(analysis => analysis.inquiry.id === 'I-9')

  // W8: 3 pallets, one pallet (2 × 24 kits) is reserved by R-12.
  assert.equal(th.governing.option.lot, 'B8')
  assert.equal(th.governing.option.pack, 'p3')
  assert.equal(th.governing.quote.id, 'W-3')
  assert.equal(th.governing.quote.saleUnit, 'pallet')
  assert.equal(th.governing.quote.saleUnitKits, 24)
  assert.equal(th.governing.stock.unreservedKits, 24)
  assert.equal(th.governing.stock.capacityKits, 24)

  // One pallet covers only one of the two required pallets, which also
  // misses the new two-pallet minimum order.
  assert.equal(th.governing.status, 'minimum-short')
  assert.equal(th.governing.deliverable, null)
  assert.equal(th.governing.capacity.quantity, 1)
  assert.equal(th.governing.gap.minimumShortfallKits, 24)
  assert.equal(th.governing.gap.minimumShortfallPackages, 1)
  assert.equal(th.status, 'minimum-short')
  assert.ok(th.pending.some(item => item.code === 'minimum-order-short'))
  assert.ok(th.pending.some(item => item.code === 'old-share-blocked'))

  // VN re-prices against W8 once its quote is published: exactly 48 kits.
  const vn = result.inquiries.find(analysis => analysis.inquiry.id === 'I-12')
  assert.equal(vn.governing.status, 'ready')
  assert.equal(vn.governing.deliverable.quantity, 2)
  assert.equal(vn.governing.deliverable.kits, 48)
  assert.equal(vn.governing.quote.id, 'W-4')
  assert.equal(vn.governing.quote.delivery, '仓库交货')
})

test('第 3 次发布：确认单只有自己的替换确认才动用新批仓位', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  await collector.collect({ step: 0 })
  await collector.collect({ step: 1 })
  await collector.collect({ step: 2 })
  const result = await collector.collect({ step: 3, includeCatalog: true })
  const byId = new Map(result.inquiries.map(analysis => [analysis.inquiry.id, analysis]))

  const warehouse = result.catalog.warehouse
  const superseded = warehouse.reservations.find(row => row.receipt === 'R-7')
  const replacement = warehouse.reservations.find(row => row.receipt === 'R-7B')
  assert.equal(superseded.state, 'superseded')
  assert.equal(superseded.active, false)
  assert.equal(replacement.state, 'confirmed')
  assert.equal(replacement.replacesReceipt, 'R-7')
  assert.equal(replacement.pool, 'W8')

  // TH-W1 is empty now; only the replacement receipt counts.
  const i7 = byId.get('I-7')
  assert.equal(i7.inquiry.signed, true)
  assert.equal(i7.governing.deliverable.kits, 24)
  assert.equal(i7.governing.deliverable.usesReplacementConfirmation, true)
  assert.equal(i7.governing.replacementConfirmation.received, true)
  assert.deepEqual(i7.governing.deliverable.packs, ['p3'])
  assert.equal(i7.governing.originalTerms.quoteId, 'W-1')
  assert.equal(i7.governing.gap.kits, 40)

  // W8 is now fully reserved by I-7 (24) and I-12 (48): 72/72.
  const w8 = result.poolLedger.pools.find(pool => pool.id === 'W8')
  assert.equal(w8.physicalKits, 72)
  assert.equal(w8.reservedKits, 72)
  assert.equal(w8.unreservedKits, 0)
  // The superseded receipt belonged to the now-empty TH-W1 pool.
  const thW1 = result.poolLedger.pools.find(pool => pool.id === 'TH-W1')
  assert.equal(thW1.supersededReceipts.includes('R-7'), true)
  assert.equal(w8.supersededReceipts.includes('R-7'), false)

  // I-9, still unconfirmed, cannot use the new stock taken by others.
  const i9 = byId.get('I-9')
  assert.equal(i9.governing.status, 'no-stock')
  assert.equal(i9.governing.deliverable, null)
  assert.ok(i9.pending.some(item => item.code === 'no-unreserved-stock'))
  assert.ok(i9.sharedPoolPeers.some(peer => peer.inquiry === 'I-7'))

  // I-12 already holds a confirmed receipt, so it keeps its own 48 kits.
  const i12 = byId.get('I-12')
  assert.equal(i12.governing.deliverable.kits, 48)
  assert.equal(i12.status, 'ready')
})

test('同池来源不各自占一遍库存：计划分配之和不超过未预留份额', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  await collector.collect({ step: 0 })
  const result = await collector.collect({ step: 1, includeCatalog: true })

  const w8 = result.poolLedger.pools.find(pool => pool.id === 'W8')
  const plannedFromW8 = w8.claims
    .filter(claim => !claim.signed)
    .reduce((total, claim) => total + claim.plannedKits + claim.plannedOldKits, 0)
  assert.ok(plannedFromW8 <= w8.unreservedKits)
  // Both inquiries may show a plan, but their sum never exceeds the pool.
  const thPlan = result.inquiries.find(item => item.inquiry.id === 'I-9')
    .evidence.allocation.current
  const vnPlan = result.inquiries.find(item => item.inquiry.id === 'I-12')
    .evidence.allocation.current
  // Neither market's B8 price is published yet, so no stock is planned; the
  // demand still shows up in the ledger.
  assert.equal(thPlan.kind, 'pending')
  assert.equal(vnPlan.kind, 'pending')
  assert.equal(w8.plannedKits, 0)
  assert.equal(result.poolLedger.allocation.order[0], 'I-7')
})

test('仓池未声明该市场时不合账，即使批号相同', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [],
    products: [{
      sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK
    }],
    lots: [{ market: 'TH', lot: 'B7', available: 4, unit: 'pallet' }],
    inquiries: [{
      id: 'I-1', sku: 'P1', market: 'VN', quantity: 64, unit: 'kit', signed: false
    }],
    historyOptions: [{
      market: 'VN', sku: 'P1', lot: 'B7', pack: 'p1', quoteId: 'W-9',
      current: false
    }],
    warehouse: {
      pools: [{ id: 'TH-W1', lot: 'B7', physicalStock: 4, unit: 'pallet', markets: ['TH'] }],
      reservations: []
    }
  })
  const analysis = analyzeInquiry(catalog, 'I-1', {})
  // VN has no destination option, and B7's pool is only declared for TH.
  assert.equal(analysis.ok, false)
  assert.equal(analysis.status, 'no-option')
  assert.ok(catalog.unlinkedOptions.length === 0)
})

test('两个不同型号没有共同标识时不合并包装与库存', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: null, lot: 'B7', pack: 'p1', quote: 'W-1' }]
    }],
    products: [
      { sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK },
      { sku: 'P2', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }
    ],
    lots: [{ market: 'TH', lot: 'B7', available: 2, unit: 'pallet' }],
    inquiries: [],
    warehouse: {
      pools: [{ id: 'P', lot: 'B7', physicalStock: 2, unit: 'pallet', markets: ['TH'] }],
      reservations: []
    }
  })
  assert.ok(catalog.warnings.some(warning => warning.code === 'ambiguous-model-identity'))
  assert.equal(catalog.currentOptions[0].packaging, null)
})

test('预留以逐条有效确认计入，被替换的收据不计', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [],
    products: [{ sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }],
    lots: [],
    inquiries: [],
    warehouse: {
      pools: [{ id: 'A', lot: 'B7', physicalStock: 3, unit: 'pallet', markets: ['TH'] }],
      reservations: [
        { inquiry: 'I-1', pool: 'A', lot: 'B7', pack: 'p1', unit: 'pallet', qty: 1,
          state: 'confirmed', receipt: 'R-1' },
        { inquiry: 'I-2', pool: 'A', lot: 'B7', pack: 'p1', unit: 'pallet', qty: 1,
          state: 'confirmed', receipt: 'R-2' },
        { inquiry: 'I-1', pool: 'A', lot: 'B7', pack: 'p1', unit: 'pallet', qty: 2,
          state: 'confirmed', receipt: 'R-3', replacesReceipt: 'R-1' }
      ]
    }
  })
  const pool = catalog.warehouse.pools[0]
  assert.equal(pool.reservedKits, 96)
  assert.equal(pool.unreservedKits, 0)
  assert.equal(pool.reservations.find(row => row.receipt === 'R-1').state, 'superseded')
  assert.equal(pool.activeReservations.length, 2)
})

test('没有有效仓位时不出具可交份额', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: 'P1', lot: 'B7', pack: 'p1', quote: 'W-1' }]
    }],
    products: [{ sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }],
    lots: [],
    inquiries: [{ id: 'I-1', sku: 'P1', market: 'TH', quantity: 64, unit: 'kit', signed: false }],
    warehouse: { pools: [], reservations: [] }
  })
  const analysis = analyzeInquiry(catalog, 'I-1', {})
  assert.equal(analysis.governing.status, 'no-pool')
  assert.equal(analysis.governing.deliverable, null)
  assert.match(analysis.governing.reason, /明确给出可用仓池/)
})

test('整包装超出所需数量时列出实际可发与超出量，交给买家决定', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: 'P1', lot: 'B7', pack: 'p1', quote: 'W-1' }]
    }],
    products: [{ sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }],
    lots: [],
    inquiries: [{ id: 'I-1', sku: 'P1', market: 'TH', quantity: 40, unit: 'kit', signed: false }],
    warehouse: {
      pools: [{ id: 'A', lot: 'B7', physicalStock: 2, unit: 'pallet', markets: ['TH'] }],
      reservations: []
    }
  })
  const quotes = {
    'TH|B7|40': {
      state: 'published', status: 200,
      body: { id: 'W-1', saleUnit: 'pallet', min: 1, maximum: 4, price: 1, delivery: '提货' }
    }
  }
  const analysis = analyzeInquiry(catalog, 'I-1', quotes)
  // 40 kits require two pallets → 64 kits, 24 more than requested.
  assert.equal(analysis.governing.status, 'exceeds-requested')
  assert.equal(analysis.governing.deliverable.quantity, 2)
  assert.equal(analysis.governing.deliverable.kits, 64)
  assert.equal(analysis.governing.excessKits, 24)
  assert.equal(analysis.governing.gap.kits, 0)
  assert.ok(analysis.pending.some(item => item.code === 'buyer-decision-excess'))
  const report = inquiryReport(analysis)
  assert.equal(report.parts[0].buyerDecisionRequired, true)
  assert.equal(report.parts[0].excessKits, 24)
})

test('部分替代只按仓库列出的数量与未预留限制折算旧份额', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: 'P1', lot: 'B8', pack: 'p2', quote: 'W-2' }]
    }],
    products: [
      { sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK },
      { sku: 'P1', pack: 'p2', market: 'TH', lot: 'B8', tree: [
        { id: 'pallet', child: 'kit', n: 24 }
      ] }
    ],
    lots: [{
      market: 'TH', lot: 'B8', available: 3, unit: 'pallet',
      replacement: {
        old: 'B7', oldPack: 'p1', units: 40, unit: 'kit',
        effectiveBatch: 'B8', fromUnreservedOnly: true
      }
    }],
    inquiries: [{ id: 'I-1', sku: 'P1', market: 'TH', quantity: 64, unit: 'kit', signed: false }],
    warehouse: {
      pools: [{
        id: 'A', lot: 'B7', physicalStock: 3, unit: 'pallet', markets: ['TH']
      }],
      reservations: [{
        inquiry: 'I-0', pool: 'A', lot: 'B7', pack: 'p1', unit: 'pallet', qty: 2,
        state: 'confirmed', receipt: 'R-0'
      }]
    }
  })
  const quotes = {
    'TH|B7|64': {
      state: 'published', status: 200,
      body: { id: 'W-1', saleUnit: 'pallet', min: 1, maximum: 10 }
    },
    'TH|B8|64': { state: 'pending', status: 404, body: { state: '未发布' } }
  }
  const analysis = analyzeInquiry(catalog, 'I-1', quotes)
  const share = analysis.oldShares.find(item => item.option.lot === 'B7')
  // A has 3 pallets, 2 reserved → 32 unreserved kits. The warehouse declares
  // only 40 kits of substitute, so 32 kits is the ceiling; one whole old
  // pallet (32 kits) ships.
  assert.equal(share.declaredKits, 40)
  assert.equal(share.convertibleKits, 32)
  assert.equal(share.deliverable.quantity, 1)
  assert.equal(share.deliverable.kits, 32)
  assert.equal(share.canShipKits, 32)
  assert.ok(share.limitReasons.some(reason => /未预留/.test(reason)))
})

test('报价接口的待发布状态不影响其他询价的结论', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  await collector.collect({ step: 0 })
  const result = await collector.collect({ step: 1 })
  const jp = result.inquiries.find(analysis => analysis.inquiry.id === 'I-10')
  // JP quote was published in release 0 and is still readable.
  assert.equal(jp.governing.quote.id, 'W-2')
  assert.equal(jp.status, 'ready')
})

test('重复采集同一发布不重复计算库存', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  const first = await collector.collect({ step: 2 })
  const second = await collector.collect({ step: 2 })
  const firstPool = first.poolLedger.pools.find(pool => pool.id === 'W8')
  const secondPool = second.poolLedger.pools.find(pool => pool.id === 'W8')
  assert.equal(secondPool.unreservedKits, firstPool.unreservedKits)
  assert.equal(secondPool.reservedKits, firstPool.reservedKits)
  const firstI9 = first.inquiries.find(item => item.inquiry.id === 'I-9')
  const secondI9 = second.inquiries.find(item => item.inquiry.id === 'I-9')
  assert.equal(secondI9.governing.deliverable, firstI9.governing.deliverable)
})

test('计划分配只作为证据，不写回仓库确认', async t => {
  const origin = await openServer(t)
  const collector = new Collector({ origin })
  const result = await collector.collect({ step: 0 })
  const pool = result.poolLedger.pools.find(item => item.id === 'TH-W1')
  assert.equal(pool.reservations.length, 1)
  assert.equal(pool.reservations[0].inquiry, 'I-7')
  assert.equal(pool.reservations[0].receipts[0], 'R-7')
  assert.equal(pool.allocationBasis.includes('不是仓库确认'), true)
  const th = result.inquiries.find(item => item.inquiry.id === 'I-9')
  assert.equal(th.governing.deliverable.planned, true)
})

test('新进程直接跳到后续发布：重放历史才能解释旧包装的确认预留', async t => {
  const origin = await openServer(t)
  const direct = await new Collector({ origin }).collect({ step: 3, includeCatalog: true })
  assert.equal(direct.inquiries.find(item => item.inquiry.id === 'I-7')
    .governing.originalTerms.quoteId, 'W-1')

  const replayed = await new Collector({ origin }).collectRange(3, { includeCatalog: true })
  const i7 = replayed.inquiries.find(item => item.inquiry.id === 'I-7')
  // R-7B was recorded in the new pack; its 24 kits come from p3.
  assert.equal(i7.governing.deliverable.kits, 24)
  assert.equal(i7.governing.deliverable.usesReplacementConfirmation, true)
  const thW1 = replayed.poolLedger.pools.find(pool => pool.id === 'TH-W1')
  assert.equal(thW1.convertible, true)
  assert.equal(thW1.physicalKits, 0)
  assert.equal(replayed.warmup.steps, 3)
})

test('页面型号与批发型号无共同标识时不合并', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: 'P9', lot: 'B7', pack: 'p1', quote: 'W-1' }]
    }],
    products: [{ sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }],
    lots: [],
    inquiries: [],
    warehouse: {
      pools: [{ id: 'A', lot: 'B7', physicalStock: 1, unit: 'pallet', markets: ['TH'] }],
      reservations: []
    }
  })
  // A conflicting explicit SKU zeros the merge, but the packaging context is
  // still resolved by market+lot+pack; the page SKU is not silently replaced.
  assert.equal(catalog.currentOptions[0].identity.pageSku, 'P9')
  assert.equal(catalog.currentOptions[0].identity.productSku, 'P1')
  assert.equal(catalog.currentOptions[0].sku, null)
})

test('报价最大量限制可交份额，但不会虚增库存', () => {
  const catalog = ensureCatalog({
    selector: [],
    markets: [{
      market: 'TH', href: '/market/th/X', title: 'X',
      articles: [{ market: 'TH', sku: 'P1', lot: 'B7', pack: 'p1', quote: 'W-1' }]
    }],
    products: [{ sku: 'P1', pack: 'p1', market: 'TH', lot: 'B7', tree: TH_PACK }],
    lots: [],
    inquiries: [{ id: 'I-1', sku: 'P1', market: 'TH', quantity: 100, unit: 'kit', signed: false }],
    warehouse: {
      pools: [{ id: 'A', lot: 'B7', physicalStock: 5, unit: 'pallet', markets: ['TH'] }],
      reservations: []
    }
  })
  const quotes = {
    'TH|B7|100': {
      state: 'published', status: 200,
      body: { id: 'W-1', saleUnit: 'pallet', min: 1, maximum: 3 }
    }
  }
  const analysis = analyzeInquiry(catalog, 'I-1', quotes)
  // 160 kits of stock, but the quote caps at 3 pallets = 96 kits.
  assert.equal(analysis.governing.stock.unreservedKits, 160)
  assert.equal(analysis.governing.deliverable.kits, 96)
  assert.equal(analysis.governing.status, 'stock-short')
  assert.equal(analysis.governing.gap.kits, 4)
})

test('同一仓池的两个未确认询价按来源顺序分份额，不能各自占满', () => {
  const tree = [{ id: 'pallet', child: 'kit', n: 24 }]
  const catalog = ensureCatalog({
    selector: [],
    markets: [
      { market: 'TH', href: '/m/th', title: 'TH',
        articles: [{ market: 'TH', sku: 'P', lot: 'B8', pack: 'p3', quote: 'W-3' }] },
      { market: 'VN', href: '/m/vn', title: 'VN',
        articles: [{ market: 'VN', sku: 'P', lot: 'B8', pack: 'p3', quote: 'W-4' }] }
    ],
    products: [
      { sku: 'P', pack: 'p3', market: 'TH', lot: 'B8', tree },
      { sku: 'P', pack: 'p3', market: 'VN', lot: 'B8', tree }
    ],
    lots: [],
    inquiries: [
      { id: 'A', sku: 'P', market: 'TH', quantity: 48, unit: 'kit', signed: false },
      { id: 'B', sku: 'P', market: 'VN', quantity: 48, unit: 'kit', signed: false }
    ],
    warehouse: {
      pools: [{ id: 'W8', lot: 'B8', physicalStock: 3, unit: 'pallet', markets: ['TH', 'VN'] }],
      reservations: []
    }
  })
  const quotes = {
    'TH|B8|48': { state: 'published', status: 200,
      body: { id: 'W-3', saleUnit: 'pallet', min: 2, maximum: 3 } },
    'VN|B8|48': { state: 'published', status: 200,
      body: { id: 'W-4', saleUnit: 'pallet', min: 2, maximum: 3 } }
  }
  const { analyses, allocation } = analyzeAll(catalog, quotes)
  const a = analyses.find(item => item.inquiry.id === 'A')
  const b = analyses.find(item => item.inquiry.id === 'B')
  // 3 pallets are 72 kits: A gets 2 (48), B only 1 (24), below its minimum.
  assert.equal(a.governing.deliverable.kits, 48)
  assert.equal(a.status, 'ready')
  assert.equal(b.governing.deliverable, null)
  assert.equal(b.status, 'minimum-short')
  assert.equal(a.sharedPoolPeers[0].inquiry, 'B')
  assert.equal(b.sharedPoolPeers[0].inquiry, 'A')
  // All 72 kits are accounted for exactly once.
  assert.equal(allocation.remainingAfterPlanning.W8, 0)
  assert.equal(allocation.byInquiry.get('A').current.pools.W8 +
    allocation.byInquiry.get('B').current.pools.W8, 72)
})
