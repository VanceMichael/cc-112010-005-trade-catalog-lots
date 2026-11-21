# 目的地市场和批发目录

两个合成站点模拟工业品市场选择与批发报价。货源号由供应商发出，价格和最小订量按各自销售单位计。

使用 Node.js 22.23.4。执行 `npm ci` 后运行 `npm start`，资料源默认监听本机 4173 端口，可用 `PORT` 指定端口。

`GET /market/selector` 和 `GET /wholesale/products` 是可浏览的资料入口。`GET /ready` 或 `GET /health` 返回当前发布序号和总发布次数。`PUT /replay` 接受 JSON `{"step":1}`，用于在联调时将来源切到指定发布时刻。发布序号从 0 开始。每次发布只列变化的来源，应答沿用上一轮存在且未被替换的地址。收到 404 并不代表之前的历史资料从业务上被撤回。重新启动服务从第 0 次发布开始。

/market/selector 公布市场路径，子页面的 data 属性是页面上的市场、批号、包装和报价编号。/wholesale/products 的包装图所给系数是外包装含有多少个直接子单位。/wholesale/quote 需要用 URL 上的 market、lot 和数量组合取得，报价中的 saleUnit 是可出售的整单位。/lots 声明旧批的替代份额，其中 units 使用 unit 指定的计量口径。/inquiries 给出需求和已保存的询价确认。
批发报价请求的 quantity 采用 kit（整组件）件数，查询仍需要市场和批号。返回中 min 与 maximum 按 saleUnit 计。parts 是组件里的零件，只有包装资料明示可拆售才可单独报价。独立站同一商品地址随批号改版时不改写旧批报价编号。

`/warehouse` 列出实体仓池的实物库存和预留确认，markets 为同仓池的销售去向。预留数量按 unit 指定的仓库单位计，physicalStock 含已预留。fromUnreservedOnly 区分只供未预留份额的替代。

仓库预留行的 receipt 为确认编号。superseded 不能再计作有效预留，replacesReceipt 说明同一询价已有单据被替换，数量仍按每行自身的包装口径读。不同市场的询价量仍以各自的需求为准。

运行 `npm test` 可校验资料源实际应答。样本内容存放在 `samples/`，开发时通过各来源的本地地址进行联调。

## 采集程序

`src/` 是采集与出结论的程序，不改动资料源。先从目的地页面领取商品与报价上下文，再从批发接口读取包装、市场和货源，最后取仓库份额与逐条预留确认。

```bash
npm start                                  # 另开一个终端启动资料源
node src/cli.mjs --step 3                  # 重放 0..2 后再取第 3 次发布的全量结论
node src/cli.mjs --step 3 --inquiry I-7    # 只看一个询价
node src/cli.mjs --step 3 --json           # 机器可读输出
```

`--step N` 默认先重放更早的发布（`--from 0`），因为后续发布只列变化的来源：新进程直接跳到第 3 次发布时，旧的包装资料和旧批页面已经不在应答里，无法解释旧包装的确认预留。只想看当前发布时加 `--no-warmup`，此时无法换算的仓池会以 `pool-not-convertible` 提示，并且不计入可交量。

程序 API：

```js
import { Collector, inquiryReport } from './src/index.mjs'

const collector = new Collector({ origin: 'http://127.0.0.1:4173' })
const result = await collector.collectRange(3)       // 或 collect({ step: 3 })
for (const analysis of result.inquiries) {
  console.log(analysis.inquiry.id, analysis.status, inquiryReport(analysis).parts)
}
```

### 结论规则

- **包装换算**：`/wholesale/products` 的 `tree` 中 `n` 是一个 `id` 单位含多少个 `child`。`splittable: false` 的边不可拆售，该边以下的单位不能单独报价或计量。整托、整盒、不可拆售多件套因此各按自己的包装口径结算。
- **买家需求**：`/inquiries` 的 `quantity` 按 `unit` 计（通常是 `kit`），程序统一折成组件数。折算不了的询价不出结论，只报原因。
- **身份合并**：页面与批发商品只在有共同标识（SKU 或 market+lot+pack）时合并。销售单位、最低订量和交货条件始终跟各自的市场选项走，不跨市场合并。两个不同型号同样匹配时记为 `ambiguous-model-identity`，不猜。
- **未确认询价**：按当前市场选项重新查价；交货量按报价 `saleUnit` 取整（例如需要 64 个组件、每托 32 个，就发 2 托，而不是库存 3 托全发）。取整后多于所需时给出实际可发量与超出量，交买家决定（`buyer-decision-excess`）。新包装最低订量不够、新市场报价未公布或库存不足时，分别列出缺口与待解决项。
- **确认询价**：保留当时的销售单位、报价和已给仓位，按每条预留自己的包装口径读数量。只有本询价自己的、带 `replacesReceipt` 的有效确认才能动用新批；别的询价的替换确认不会把新货算给它。`superseded` 的收据不计。
- **旧批份额**：`/lots` 的 `replacement` 说明从哪个旧批接续；`units` 按 `unit` 计，是仓库列出的替代份额上限。`fromUnreservedOnly` 时只能用该仓池的未预留份额，部分替代只按列出的数量折算。替代份额凑不够一个旧包装单位时不出可交量，只报限制原因。
- **仓池**：`/warehouse` 的 `markets` 是同一个实体仓池的销售去向。同池的多个来源共用一份库存，程序按来源顺序做一次确定性分配，计划结果只作证据（`allocationBasis`），不写回仓库确认。两个来源同池的未预留需求超出余量时报 `shared-pool-contention`，并说明另一个询价为何不能照搬结论。没有 `markets` 明确指向同一池时，即使批号相同也不合账。
- **可追溯证据**：每个询价返回 `evidence`（站点选项、报价、包装、仓池、预留行）与 `sharedPoolPeers`；`poolLedger` 汇总各池的实物、有效预留、未预留、未确认需求、计划分配和被替换收据。

