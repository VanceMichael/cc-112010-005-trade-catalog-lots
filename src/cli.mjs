#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   node src/cli.mjs                          # full report at the current release
 *   node src/cli.mjs --step 2                 # switch the source to release 2
 *   node src/cli.mjs --inquiry I-9            # one inquiry, buyer-facing parts
 *   node src/cli.mjs --inquiry I-9 --json     # machine readable
 *   node src/cli.mjs --origin http://host:4173
 *
 * Exit codes: 0 success, 1 usage/source error, 2 an inquiry could not be
 * found or has no usable option.
 */

import { Collector } from './collector.mjs'
import { inquiryReport } from './analysis.mjs'
import { SourceError } from './source-client.mjs'

function parseArgs(argv) {
  const options = { origin: process.env.SOURCE_ORIGIN ?? 'http://127.0.0.1:4173', json: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const take = () => {
      const value = argv[++index]
      if (value === undefined) throw new UsageError(`参数 ${arg} 缺少值`)
      return value
    }
    switch (arg) {
      case '--origin': options.origin = take(); break
      case '--step': {
        const step = Number(take())
        if (!Number.isInteger(step) || step < 0) throw new UsageError('--step 必须是非负整数')
        options.step = step
        break
      }
      case '--inquiry': options.inquiry = take(); break
      case '--from': {
        const from = Number(take())
        if (!Number.isInteger(from) || from < 0) throw new UsageError('--from 必须是非负整数')
        options.from = from
        break
      }
      case '--no-warmup': options.from = null; break
      case '--json': options.json = true; break
      case '--catalog': options.includeCatalog = true; break
      case '--help':
      case '-h': options.help = true; break
      default: throw new UsageError(`未知参数 ${arg}`)
    }
  }
  return options
}

class UsageError extends Error {}

const HELP = `用法：node src/cli.mjs [选项]

  --origin <url>   资料源地址（默认 http://127.0.0.1:4173，也可用 SOURCE_ORIGIN）
  --step <n>       先把资料源切到发布序号 n 再采集
  --from <n>       预热起始发布序号（默认 0）；给 --step 时先重放 0..n-1
  --no-warmup      直接读取目标发布，不重放更早的发布
  --inquiry <id>   只输出该询价的可交结论
  --json           输出 JSON（默认输出便于阅读的摘要）
  --catalog        在 JSON 中附上完整目录
  -h, --help       显示本帮助
`

function formatKits(value) {
  return Number.isFinite(value) ? String(value) : '未知'
}

function humanReport(result) {
  const lines = []
  lines.push(`资料源 ${result.origin}${result.step === null ? '' : `（发布 ${result.step}）`}`)
  lines.push(`市场 ${result.counts.markets}，目的地选项 ${result.counts.options}，` +
    `询价 ${result.counts.inquiries}，仓池 ${result.counts.pools}，` +
    `报价 ${result.counts.quotesPublished}/${result.counts.quotesRequested}`)
  if (result.warnings.length) {
    lines.push('')
    lines.push('注意：')
    for (const warning of result.warnings) lines.push(`  - ${warning.message}`)
  }
  for (const analysis of result.inquiries) {
    lines.push('')
    if (!analysis.ok) {
      lines.push(`询价 ${analysis.inquiryId ?? '?'}：${analysis.reason}`)
      continue
    }
    const report = inquiryReport(analysis)
    lines.push(`询价 ${report.inquiry.id}（${report.inquiry.market}，` +
      `${report.inquiry.signed ? '已确认' : '未确认'}，需 ${formatKits(report.inquiry.requiredKits)} 个组件）` +
      ` → ${report.status}`)
    for (const part of report.parts) {
      const quantity = part.deliverableQuantity === null || part.deliverableQuantity === undefined
        ? ''
        : ` ${part.deliverableQuantity}${part.deliverableUnit ?? ''}`
      lines.push(`  ${part.part}：${part.status}${quantity}` +
        `（${formatKits(part.deliverableKits)} 个组件）` +
        (part.gapKits ? `，还差 ${part.gapKits} 个组件` : ''))
      if (part.limitReasons?.length) lines.push(`    限制：${part.limitReasons.join('；')}`)
    }
    for (const pending of report.pending) lines.push(`  待解决：${pending.message}`)
    for (const peer of report.sharedPoolPeers) {
      lines.push(`  同池：${peer.reason}`)
    }
  }
  if (result.poolLedger?.pools?.length) {
    lines.push('')
    lines.push('仓池台账：')
    for (const pool of result.poolLedger.pools) {
      const stock = pool.convertible
        ? `实物 ${formatKits(pool.physicalKits)}，已确认预留 ${formatKits(pool.reservedKits)}，` +
          `未预留 ${formatKits(pool.unreservedKits)}，`
        : `实物 ${formatKits(pool.physicalStock)}${pool.unit ?? ''}（无法换算成组件：${pool.conversionError}），`
      lines.push(`  ${pool.id}（${pool.lot ?? '?'}）：${stock}` +
        `未确认需求 ${formatKits(pool.demandKits)}，计划分配 ${formatKits(pool.plannedKits)}` +
        (pool.contention ? '（份额不足）' : ''))
    }
  }
  return lines.join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(HELP)
    process.exit(1)
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  try {
    const collector = new Collector({
      origin: options.origin,
      remember: true
    })
    const collectOptions = {
      step: options.step,
      includeCatalog: options.includeCatalog
    }
    const warmup = options.from !== null && Number.isInteger(options.step)
    if (warmup) collectOptions.from = options.from ?? 0
    if (options.inquiry) {
      const result = await collector.collectInquiry(options.inquiry, collectOptions)
      if (!result.inquiry) {
        console.error(`资料源没有询价 ${options.inquiry}`)
        process.exit(2)
      }
      if (options.json) {
        console.log(JSON.stringify({
          ok: result.inquiry.ok,
          report: result.report,
          inquiry: result.inquiry,
          ledger: result.poolLedger
        }, null, 2))
      } else {
        console.log(humanReport({ ...result, inquiries: [result.inquiry] }))
      }
      return
    }
    const result = warmup
      ? await collector.collectRange(options.step, collectOptions)
      : await collector.collect(collectOptions)
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(humanReport(result))
    }
  } catch (error) {
    if (error instanceof SourceError) {
      console.error(error.message)
      process.exit(1)
    }
    console.error(error?.stack ?? String(error))
    process.exit(1)
  }
}

main()
