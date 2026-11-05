# CONTRACT v1.2.2 — 导入/导出格式与薄荷记账兼容

> 权威规格。实现方：`server/` = backend-api，`web/` = web-pwa（**web 就是 APK 的内核，改 web 即改 APK 的 UI**），`android/` = android-shell（只重打包）。
> 目标：① 导入/导出可选格式，**默认 CSV**；② 导入能直接吃「薄荷记账」导出的文件；③ 导出也能产出薄荷能回导的格式，两个 App 账单互通。

## 1. 三种格式

| key | 名称 | 编码 / 分隔 | 用途 |
|---|---|---|---|
| `csv` | 本 App CSV（**默认**） | UTF-8 + BOM，逗号，CRLF | 表格软件打开、人工核对 |
| `mint` | 薄荷记账兼容 | **UTF-16LE + BOM**，**TAB** 分隔，CRLF | 与薄荷互导 |
| `json` | 完整备份 | UTF-8 | 迁移、备份（含账户/分类/标签/预算/周期规则） |

## 2. 薄荷格式实测（样本：`薄荷记账_2026年11月5日.csv`，2556 行）

- 编码 UTF-16LE + BOM（`FF FE`），**扩展名是 .csv 但实际是 TAB 分隔**，19 列。
- 表头：
  `类型 货币 金额 汇率（相对本位币） 项目 分类 父类 账户 付款 收款 商家 地址 日期 标签 作者 备注 图一 图二 图三`
- 取值特征：
  - `类型` ∈ {支出, 收入, 转账}（2385 / 132 / 39）
  - `金额`：支出为**负数**，收入/转账为正数，无千分位、无货币符号
  - `分类`：扁平名（餐饮/日用/饮料/交通/零食/水果/通讯/其他/红包/服饰/购物/账户互转/工资/房租/水电/旅行/漏记收入/长辈/投资/娱乐/奖金/利息/漏记支出/礼金/医疗/借出），`父类` 全空
  - `账户`：支出/收入的账户；**空表示未指定（2037/2556 行都是空）**
  - `付款` / `收款`：仅转账行有值（转出 / 转入）
  - `日期`：`YYYY-MM-DD HH:mm`（固定 16 字符）
  - `作者`：人名（萱萱 1999 / Jake 557）→ 对应我们的 `members`
  - `标签`、`商家`、`地址`、`项目`、`备注`、`图一~三`：样本中基本为空，但解析要容忍任意值

## 3. 导入映射（薄荷 → 内部）

| 薄荷列 | 内部字段 | 规则 |
|---|---|---|
| 类型 | `type` | 支出→`expense`（金额取绝对值）、收入→`income`、转账→`transfer`（`category_id = null`） |
| 金额 | `amount_cents` | `Math.round(Math.abs(Number(金额)) * 100)` |
| 分类 | `category_id` | 按名字在本账本找同名分类；没有就**创建**（`kind` 跟随交易类型）；转账忽略该列 |
| 账户 | `account_id` | 按名字找；没有就创建（类型猜测：微信/支付宝→`ewallet`，现金→`cash`，指数基金/基金→`invest`，借款/白条→`payable`，其余→`other`）。**空值 → 单例账户「未指定」**（`type='other'`, `kind='asset'`, `include_in_net=0`） |
| 付款 / 收款 | `account_id` / `to_account_id` | 仅转账；空则回落到「未指定」 |
| 日期 | `happened_at` | 原样存 `YYYY-MM-DD HH:mm`（没有时间就补 `00:00`） |
| 作者 | `member_id` | 按名字找 member，没有就创建（`is_self=0`，颜色按调色板轮转）；空 → `member_id = null`（= 「我」） |
| 标签 | `tags` | 按 `,` `，` `、` `\|` 拆分，去空、去重、自动创建 |
| 备注 + 商家 | `note` | `商家` 非空时 `备注 ? 备注 + ' · ' + 商家 : 商家` |
| 货币 ≠ CNY | `note` | 前缀 `[货币 XXX 汇率 X.XXXX] ` |
| 整行原文 | `external_id` | `'mint:' + sha1(原始行文本)`（40 位 hex）→ **重复导入幂等** |
| 项目 / 父类 / 地址 / 图一~三 | — | 丢弃 |

## 4. 导出映射（内部 → 薄荷）

19 列逐列产出：`类型`（支出/收入/转账）、`货币`=`CNY`、`金额`（支出取负、其余为正，`(cents/100)` 去掉多余的 0，至少保留整数部分）、`汇率`=`1.0000`、`项目`=空、`分类`=`category_name`（转账写 `账户互转`）、`父类`=空、`账户`=支出/收入账户名（转账留空）、`付款`/`收款`=转账两端、`商家`=空、`地址`=空、`日期`=`YYYY-MM-DD HH:mm`（内部只有日期则补 `00:00`）、`标签`=`,` 连接、`作者`=`member_name`（空则空）、`备注`=`note`、`图一~三`=空。
文件编码 **UTF-16LE + BOM**，行尾 CRLF，字段内如含 TAB/换行 → 替换为空格（薄荷不做引号转义）。

## 5. 自动识别（导入默认 `format='auto'`）

按顺序判断，命中即用：

1. 前两字节 `FF FE` → `mint`（UTF-16LE）；`FE FF` → `mint`（UTF-16BE，顺手支持）
2. 去 BOM 后首个非空字符是 `{` 或 `[` → `json`
3. 首个非空行含 `类型` 且含 `金额` 且含 `日期` 且列数 ≥ 15（TAB 或逗号任一）→ `mint`
4. 首个非空行含 `日期` 且含 `类型` 且含 `金额` → `csv`
5. 其余 → 400 `unrecognized_format`

也允许显式传 `format` ∈ `auto|csv|mint|json`（前端下拉：自动识别 / 本 App CSV / 薄荷记账 / JSON）。

## 6. 接口

### `GET /api/v1/export?ledger_id=&format=csv|mint|json`
- 默认 `csv`（保持向后兼容）。
- `mint` → `Content-Type: text/plain; charset=utf-16le`，文件名 `mintlite-<账本>-<日期>.txt`（薄荷只认内容不认扩展名，给 .txt 免得被表格软件按 UTF-8 打开成乱码）；`Content-Disposition` 仍用 RFC 5987 双写法（中文名走 `filename*`）。

### `POST /api/v1/import`
```json
{ "ledger_id": "...", "format": "auto", "data": "<文件原文或 JSON 对象>", "dry_run": false }
```
返回：
```json
{ "created": 2556, "updated": 0, "skipped": 0,
  "accounts_created": 1, "categories_created": 9, "members_created": 2, "tags_created": 0,
  "format": "mint", "warnings": ["第 12 行金额无法解析，已跳过"] }
```
- `dry_run=true` 只解析不落库（给前端做「预览 2556 条」）。
- 同一文件导第二次：`created=0, skipped=2556`。
- 单条失败不中断：跳过并计入 `warnings`（最多保留前 20 条）。

## 7. 前端 UI（`#/me` → 数据区）

- **导出**：`select` 格式（`CSV（默认）` / `薄荷记账` / `JSON 备份`）+「导出」按钮；文件名带日期。
- **导入**：`select` 格式（`自动识别（默认）` / `本 App CSV` / `薄荷记账` / `JSON`）+「选择文件」按钮；选完文件先 `dry_run` 预览，弹确认框「将导入 N 条（跳过 M 条）」，确认后落库并 toast 汇总。
- 本地模式（IndexedDB）与服务器模式行为一致；本地模式解析用 `TextDecoder('utf-16le')` 处理 BOM。

## 8. 验收（Lead 会用真实样本独立跑）

1. 本地模式导入真实样本 → `created=2556`、`skipped=0`；明细里 11 月有 2385 条支出、132 条收入、39 条转账；成员出现「萱萱 / Jake」；「未指定」账户存在且 `include_in_net=0`。
2. 再导一次同文件 → `created=0, skipped=2556`。
3. 导出 `mint` → 编码 `FF FE`、TAB 分隔、19 列、行数 = 2556+1；再导回一个新账本 → 条数与金额合计一致。
4. 导出 `csv`（默认）仍能导回。
5. `server/test/smoke.mjs` 加至少 8 条：格式识别、导入幂等、导出 mint 编码/列数、`format=mint` 头、`dry_run`、非法格式 400。
