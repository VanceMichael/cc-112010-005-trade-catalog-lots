/**
 * Public entry point.
 *
 *   import { Collector, collect } from 'trade-catalog-lots-sources'
 *
 *   const collector = new Collector({ origin: 'http://127.0.0.1:4173' })
 *   const result = await collector.collect()
 *   const { analysis, report } = await collector.analyze('I-9')
 */

export { Collector, collectSnapshot as collect, buildPoolLedger } from './collector.mjs'
export {
  analyzeAll,
  analyzeInquiry,
  annotateSharedPools,
  buildAllocation,
  inquiryReport,
  normalizeQuote,
  planQuoteRequests
} from './analysis.mjs'
export {
  attachPoolSources,
  buildCatalog,
  choosePackagingForLot,
  chooseProduct,
  ensureCatalog,
  lotRow,
  normalizeInquiries,
  normalizeLots,
  normalizeProducts,
  optionCandidatesFor,
  optionForLot,
  poolsFor,
  replacementForLot,
  reservationsFor,
  summarizePool
} from './model.mjs'
export { buildPackageModel, normalizeTree, packagesHaveSameTree } from './packaging.mjs'
export { KIT, isKitUnit, normalizeUnit, requestedKits } from './units.mjs'
export { SourceClient, SourceError, parseMarketPage, parseSelector } from './source-client.mjs'
