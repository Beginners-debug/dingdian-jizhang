# 契约 v1（前后端共同遵守）

项目根：`D:\deepseek-harness\_sessions\2026-11-04_2014_money-tracker`
代号：**MintLite / 薄荷轻记**

## 0. 硬约束

- 金额一律 **整数分**（`amount_cents`，int）。禁止浮点存储金额。展示层 `/100` 保留 2 位。
- 时间一律 **ISO-8601 带时区**字符串（`2026-11-04T20:14:10+01:00`）或纯日期 `2026-11-04`（`happened_at` 允许纯日期，表示"哪天花的"）。
- 所有 id 用 **字符串 ULID 风格**：`crypto.randomUUID()` / `Date.now().toString(36)+random`。前端离线也要能生成 id（不能依赖服务端自增）。
- 所有列表接口返回 `{ "items": [...], "total": n }`；错误返回 `{ "error": { "code": "...", "message": "..." } }` + 对应 HTTP 状态码。
- 软删除：`deleted_at` 非空即视为删除；列表默认过滤。
- 账本（ledger）是数据隔离边界：除 `users` 外每张表都带 `ledger_id`。

## 1. 数据模型

```
users        id, username, password_hash, created_at
ledgers      id, user_id, name, currency('CNY'), is_default, created_at, updated_at, deleted_at
accounts     id, ledger_id, name, type('cash'|'bank'|'credit'|'invest'|'other'),
             balance_cents, icon, sort, include_in_net, created_at, updated_at, deleted_at
categories   id, ledger_id, name, kind('expense'|'income'), icon, sort, parent_id,
             created_at, updated_at, deleted_at
transactions id, ledger_id, type('expense'|'income'|'transfer'), amount_cents,
             category_id, account_id, to_account_id, note, happened_at,
             source('manual'|'auto'|'import'), external_id,
             created_at, updated_at, deleted_at
budgets      id, ledger_id, month('YYYY-MM'), category_id(NULL=总预算), amount_cents,
             created_at, updated_at
```

约定：
- `type='transfer'` 时 `category_id` 为空，`account_id` 转出、`to_account_id` 转入，不计入收支统计。
- `credit` 账户 `balance_cents` 为负数表示欠款。
- `external_id` 用于导入去重（同 ledger 内唯一，可空）。

## 2. REST API（前缀 `/api/v1`）

鉴权：`Authorization: Bearer <token>`。token 为服务端签发的 HMAC 串（`base64url(payload).base64url(sig)`），payload 含 `uid`、`exp`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok:true, version, time}`，免鉴权 |
| POST | `/auth/register` | `{username,password}` → `{token,user}` |
| POST | `/auth/login` | 同上 |
| GET | `/me` | 当前用户 |
| GET/POST | `/ledgers` | 列表 / 新建 `{name,currency}` |
| PATCH/DELETE | `/ledgers/:id` | 改名 / 软删 |
| GET/POST | `/accounts?ledger_id=` | 列表 / 新建 |
| PATCH/DELETE | `/accounts/:id` | 改 / 软删 |
| GET/POST | `/categories?ledger_id=&kind=` | 列表 / 新建 |
| PATCH/DELETE | `/categories/:id` | 改 / 软删 |
| GET | `/transactions?ledger_id=&from=&to=&type=&category_id=&account_id=&q=&limit=&offset=` | 按 `happened_at` 倒序 |
| POST | `/transactions` | 新建（带 `client_id` 幂等键可选） |
| PATCH/DELETE | `/transactions/:id` | 改 / 软删 |
| GET | `/stats/summary?ledger_id=&from=&to=` | `{income_cents, expense_cents, balance_cents, count}` |
| GET | `/stats/by-category?ledger_id=&from=&to=&kind=expense` | `[{category_id,name,icon,amount_cents,ratio}]` |
| GET | `/stats/trend?ledger_id=&from=&to=&granularity=day\|month` | `[{bucket,income_cents,expense_cents}]` |
| GET | `/budgets?ledger_id=&month=YYYY-MM` | 当月预算 + 已用 |
| PUT | `/budgets` | `{ledger_id,month,category_id,amount_cents}` upsert |
| GET | `/export?ledger_id=&format=json\|csv` | 全量导出 |
| POST | `/import` | `{ledger_id, data}` 幂等导入 |

新建交易请求体：

```json
{ "id":"<client-uuid>", "ledger_id":"...", "type":"expense", "amount_cents":2350,
  "category_id":"...", "account_id":"...", "to_account_id":null,
  "note":"午饭", "happened_at":"2026-11-04", "source":"manual", "external_id":null }
```

`id` 由客户端生成，服务端 upsert（同 id 覆盖），保证离线补传幂等。

## 3. 前端存储适配器接口（web 与 flutter 都要实现同一套）

```js
interface Store {
  init(): Promise<void>
  listLedgers() / createLedger / updateLedger / deleteLedger
  listAccounts(ledgerId) / createAccount / updateAccount / deleteAccount
  listCategories(ledgerId, kind?) / createCategory / updateCategory / deleteCategory
  listTransactions(filter) -> {items,total}
  createTransaction(tx) / updateTransaction(id, patch) / deleteTransaction(id)
  summary(ledgerId, from, to) -> {income_cents, expense_cents, balance_cents, count}
  byCategory(ledgerId, from, to, kind) -> [...]
  trend(ledgerId, from, to, granularity) -> [...]
  getBudgets(ledgerId, month) / setBudget(...)
  exportAll(ledgerId) / importAll(ledgerId, data)
}
```

两个实现：`LocalStore`（IndexedDB，离线、默认）与 `ApiStore`（fetch 到 Node 服务端）。设置页可切 baseUrl + token。

## 4. 记账 UI 必须有的骨架（照薄荷记账）

1. 底部 4 tab：**记账 / 明细 / 报表 / 我的**
2. 记账页：金额显示区 + **四则运算键盘**（`+ - × ÷ =`，支持连续运算）+ 分类宫格（最近使用置顶）+ 账户选择 + 日期 + 备注 + 保存
3. 明细页：按月分组、按日小计、左滑/长按删除、点击编辑
4. 报表页：月收支卡片、分类饼图/条形、日趋势折线、月份切换
5. 我的页：账本管理、账户管理、分类管理、预算、导入导出、云同步设置、关于

## 5. 目录与写入边界（团队协作，勿越界）

| 目录 | 负责人 | 内容 |
|---|---|---|
| `docs/` | lead | PLAN.md、CONTRACT.md、README 相关 |
| `server/` | backend-api | Node 零依赖服务 + `test/smoke.mjs` |
| `web/` | web-pwa | PWA 前端（原生 JS，无构建步骤） |
| `android/` | android-shell | WebView 壳 + 无 Gradle 构建脚本，产出签名 APK |
| 根 `README.md` | lead | 汇总 |

依赖安装只允许项目内：`npm i -D` 到 `server/`（能不用就不用，node:sqlite 已内置）。
