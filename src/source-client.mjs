/**
 * HTTP client for the destination-market / wholesale source.
 *
 * The source has two halves:
 *   - HTML destination pages reached from /market/selector
 *   - JSON wholesale, lots, inquiry and warehouse resources
 *
 * A 404 from a quote URL means "this combination has not been published yet";
 * it is not a transport failure and must be kept as a pending quote.  The
 * README is explicit that a 404 does not withdraw earlier historical data,
 * so callers may keep previously observed quote definitions in a cache.
 */

import { load } from 'cheerio'
import { describeError } from './util.mjs'

export class SourceError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'SourceError'
    this.details = details
  }
}

export function normalizeOrigin(origin) {
  const url = origin instanceof URL ? origin : new URL(String(origin))
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SourceError(`不支持的来源协议：${url.protocol}`)
  }
  return url.href.endsWith('/') ? url : url + '/'
}

async function readBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export class SourceClient {
  constructor(origin, options = {}) {
    this.origin = normalizeOrigin(origin)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 5000
    this.retries = options.retries ?? 1
    this.headers = options.headers ?? {}
    this.quoteCache = new Map()
  }

  async request(path, options = {}) {
    const url = new URL(path, this.origin)
    let lastError = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          ...options,
          signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
          headers: { ...this.headers, ...(options.headers ?? {}) }
        })
        const body = await readBody(response)
        return { status: response.status, body, headers: response.headers, url: url.href }
      } catch (error) {
        lastError = error
        if (attempt === this.retries) break
      }
    }
    throw new SourceError(`无法读取来源 ${url.href}：${describeError(lastError)}`, {
      path, cause: lastError
    })
  }

  async getJson(path, options = {}) {
    const result = await this.request(path, options)
    if (result.status !== 200) {
      throw new SourceError(`来源 ${path} 返回 ${result.status}`, { path, ...result })
    }
    if (typeof result.body === 'string') {
      throw new SourceError(`来源 ${path} 返回的不是 JSON`, { path, ...result })
    }
    return result.body
  }

  async getText(path, options = {}) {
    const result = await this.request(path, options)
    if (result.status !== 200) {
      throw new SourceError(`来源 ${path} 返回 ${result.status}`, { path, ...result })
    }
    if (typeof result.body !== 'string') {
      throw new SourceError(`来源 ${path} 返回的不是 HTML`, { path, ...result })
    }
    return result.body
  }

  async health() {
    return this.getJson('/ready')
  }

  async replay(step) {
    const result = await this.request('/replay', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step })
    })
    if (result.status !== 200) {
      throw new SourceError(`无法切到发布序号 ${step}（HTTP ${result.status}）`, { step, ...result })
    }
    return result.body
  }

  /**
   * Read a quote.  Missing quote combinations are returned as an explicit
   * pending state instead of throwing, because re-pricing an unconfirmed
   * inquiry is expected to discover not-yet-published market options.
   */
  async quote(market, lot, quantity, options = {}) {
    const cacheKey = [market, lot, quantity].join('|')
    if (!options.refresh && this.quoteCache.has(cacheKey)) {
      return this.quoteCache.get(cacheKey)
    }
    const search = new URLSearchParams({ market, lot, quantity: String(quantity) })
    const result = await this.request('/wholesale/quote?' + search.toString(), options)
    const quote = result.status === 200
      ? { state: 'published', status: 200, body: result.body }
      : { state: 'pending', status: result.status, body: result.body }
    this.quoteCache.set(cacheKey, quote)
    return quote
  }

  /** Fetch one destination page and expose its article contexts. */
  async marketPage(href, expectedMarket = null, options = {}) {
    const html = await this.getText(href, options)
    return parseMarketPage(html, href, expectedMarket)
  }

  async snapshot(options = {}) {
    if (Number.isInteger(options.step)) await this.replay(options.step)

    const [selectorHtml, products, lots, inquiries, warehouse] = await Promise.all([
      options.selectorHtml ?? this.getText('/market/selector'),
      options.products ?? this.getJson('/wholesale/products'),
      options.lots ?? this.getJson('/lots'),
      options.inquiries ?? this.getJson('/inquiries'),
      options.warehouse ?? this.getJson('/warehouse')
    ])

    const selector = parseSelector(selectorHtml)
    const pages = await Promise.all(selector.map(async entry => {
      try {
        return await this.marketPage(entry.href, entry.market, options)
      } catch (error) {
        return {
          market: entry.market,
          href: entry.href,
          error: describeError(error),
          articles: []
        }
      }
    }))

    return {
      origin: this.origin,
      fetchedAt: new Date().toISOString(),
      selector,
      markets: pages,
      products: Array.isArray(products) ? products : [],
      lots: Array.isArray(lots) ? lots : [],
      inquiries: Array.isArray(inquiries) ? inquiries : [],
      warehouse: warehouse && typeof warehouse === 'object' ? warehouse : { pools: [], reservations: [] }
    }
  }
}

export function parseSelector(html) {
  const $ = load(html)
  const entries = []
  const seen = new Set()
  $('a[data-market]').each((_, element) => {
    const anchor = $(element)
    const market = anchor.attr('data-market')?.trim()
    const href = anchor.attr('href')?.trim()
    if (!market || !href) return
    const key = market + '|' + href
    if (seen.has(key)) return
    seen.add(key)
    entries.push({ market, href, label: anchor.text().trim() || null })
  })
  return entries
}

export function parseMarketPage(html, href, expectedMarket = null) {
  const $ = load(html)
  const title = $('h1').first().text().trim() || null
  const articles = []
  const seen = new Set()
  const candidates = $('[data-market], [data-lot], [data-pack], [data-quote]').toArray()
  for (const element of candidates) {
    const node = $(element)
    const lot = node.attr('data-lot')?.trim() ?? null
    const pack = node.attr('data-pack')?.trim() ?? null
    const quote = node.attr('data-quote')?.trim() ?? null
    const market = node.attr('data-market')?.trim() || expectedMarket
    if (!lot && !pack && !quote) continue
    const sku = node.attr('data-sku')?.trim() ?? null
    const key = [market, sku, lot, pack, quote].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    articles.push({ market, sku, lot, pack, quote, href, title })
  }
  return { market: expectedMarket ?? articles[0]?.market ?? null, href, title, articles }
}

/**
 * Fetch all quote combinations requested by the analysis layer.
 * `requests` is a list of { market, lot, quantity }.
 */
export async function fetchQuotes(client, requests, options = {}) {
  const unique = new Map()
  for (const request of requests) {
    if (!request?.market || !request?.lot || request.quantity === null || request.quantity === undefined) continue
    const key = [request.market, request.lot, request.quantity].join('|')
    if (!unique.has(key)) unique.set(key, request)
  }
  const entries = await Promise.all([...unique].map(async ([key, request]) => {
    try {
      return [key, await client.quote(request.market, request.lot, request.quantity, options)]
    } catch (error) {
      return [key, { state: 'error', status: 0, error: describeError(error) }]
    }
  }))
  return Object.fromEntries(entries)
}
