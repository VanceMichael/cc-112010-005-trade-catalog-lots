# 目的地市场和批发目录

两个合成站点模拟工业品市场选择与批发报价。货源号由供应商发出，价格和最小订量按各自销售单位计。

使用 Node.js 22.23.4。执行 `npm ci` 后运行 `npm start`，资料源默认监听本机 4173 端口，可用 `PORT` 指定端口。

`GET /market/selector` 和 `GET /wholesale/products` 是可浏览的资料入口。`GET /ready` 返回当前发布序号和总发布次数。`PUT /replay` 接受 JSON `{"step":1}`，用于在联调时将来源切到指定发布时刻。发布序号从 0 开始。每次发布只列变化的来源，应答沿用上一轮存在且未被替换的地址。收到 404 并不代表之前的历史资料从业务上被撤回。重新启动服务从第 0 次发布开始。

/market/selector 公布市场路径，子页面的 data 属性是页面上的市场、批号、包装和报价编号。/wholesale/products 的包装图所给系数是外包装含有多少个直接子单位。/wholesale/quote 需要用 URL 上的 market、lot 和数量组合取得，报价中的 saleUnit 是可出售的整单位。/lots 声明旧批的替代份额，其中 units 使用 unit 指定的计量口径。/inquiries 给出需求和已保存的询价确认。
批发报价请求的 quantity 采用 kit（整组件）件数，查询仍需要市场和批号。返回中 min 与 maximum 按 saleUnit 计。parts 是组件里的零件，只有包装资料明示可拆售才可单独报价。独立站同一商品地址随批号改版时不改写旧批报价编号。

`/warehouse` 列出实体仓池的实物库存和预留确认，markets 为同仓池的销售去向。预留数量按 unit 指定的仓库单位计，physicalStock 含已预留。fromUnreservedOnly 区分只供未预留份额的替代。

仓库预留行的 receipt 为确认编号。superseded 不能再计作有效预留，replacesReceipt 说明同一询价已有单据被替换，数量仍按每行自身的包装口径读。不同市场的询价量仍以各自的需求为准。

运行 `npm test` 可校验资料源实际应答。样本内容存放在 `samples/`，开发时通过各来源的本地地址进行联调。
