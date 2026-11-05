# MintLite v1.1 契约增量（资产 / 预算结转 / 周期记账 / 标签 / 报销 / 报表筛选）

> 本文件只写 **v1.1 相对 v0.1 的变化**。v0.1 的接口、字段、错误码全部保留不变（向后兼容），
> 老客户端继续可用。所有金额仍是**整数分** `amount_cents`，所有 id 仍是客户端生成 UUID。

工作目录：`D:\deepseek-harness\_sessions\2026-11-04_2014_money-tracker`
写入边界：`backend-api` 只写 `server/`；`web-pwa` 只写 `web/`；`android-shell` 只写 `android/`。

---

## 1. 数据模型变更

### 1.1 accounts（扩展，ALTER TABLE）

| 新字段 | 类型 | 说明 |
|---|---|---|
| `kind` | TEXT NOT NULL DEFAULT `'asset'` | `asset` 资产 / `liability` 负债。**净资产 = Σasset − Σliability** |
| `credit_limit_cents` | INTEGER NOT NULL DEFAULT 0 | 信用卡/花呗额度，0 = 无额度概念 |

`type` 取值扩展为：`cash` 现金、`bank` 银行卡、`ewallet` 电子钱包（支付宝/微信）、`credit` 信用消费（信用卡/花呗/借呗）、`invest` 投资理财、`receivable` 应收款、`payable` 应付款、`other` 其它。
旧的 `credit`（信用卡）语义不变，仍归 `kind='liability'`。

**迁移规则（幂等）**：`PRAGMA table_info(accounts)` 里没有 `kind` 就 `ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'asset'`，然后
`UPDATE accounts SET kind='liability' WHERE type='credit' AND kind='asset'`。
`include_in_net` 保留：=0 的账户不计入净资产（例如"已注销卡"）。

### 1.2 budgets（扩展）

| 新字段 | 类型 | 说明 |
|---|---|---|
| `rollover` | INTEGER NOT NULL DEFAULT 0 | 1 = 开启结转 |

### 1.3 新表

```sql
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_ledger_name ON tags (ledger_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                -- expense / income / transfer
  amount_cents INTEGER NOT NULL,
  category_id TEXT,
  account_id TEXT,
  to_account_id TEXT,
  note TEXT,
  freq TEXT NOT NULL,                -- daily / weekly / monthly / yearly
  interval INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,          -- YYYY-MM-DD
  end_date TEXT,                     -- 可空
  next_run TEXT NOT NULL,            -- YYYY-MM-DD
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_rules (ledger_id, enabled, next_run);
```

### 1.4 transactions（扩展）

| 新字段 | 类型 | 说明 |
|---|---|---|
| `reimburse_state` | TEXT | NULL 普通 / `pending` 待报销 / `done` 已报销 |
| `reimburse_at` | TEXT | 报销到账日期 |

标签不进 transactions 表，走 `transaction_tags` 关联表；交易出参统一多一个 `tags: string[]`（标签 id 数组）。

---

## 2. 接口增量（前缀 `/api/v1`，全部需要 Bearer token）

### 2.1 账户

- `GET /accounts` — 出参在原有数组基础上，每项多 `kind`、`credit_limit_cents`、`used_cents`（仅 credit 类：`max(0, -balance_cents)`）。
  **另外返回一个聚合对象**：改成 `{ items: [...], totals: { asset_cents, liability_cents, net_cents } }`。
  ⚠️ 这是**唯一一处破坏性变更**：v0.1 前端读裸数组。前端已同步改，服务端加 `?legacy=1` 时返回裸数组兜底。
- `POST /accounts` / `PATCH /accounts/:id` — body 增加 `kind`、`credit_limit_cents`，其余不变。
- `POST /accounts/:id/adjust` — `{ target_cents: int, note?: string, date?: 'YYYY-MM-DD' }`
  把余额直接改成 `target_cents`，**同时插入一条 `type='adjust'` 的流水**（`category_id=null`，`note` 默认「余额调整」），
  这样账实相符、可追溯。返回 `{ account, transaction }`。`type='adjust'` 不参与收入/支出统计。

### 2.2 标签

- `GET /tags` → 裸数组 `[{id,name,color,usage_count}]`（`usage_count` = 引用它的交易数，可选算）
- `POST /tags` `{id?, name, color?}` → 201 单个对象；重名 409 `tag_exists`
- `PATCH /tags/:id` `{name?, color?}`
- `DELETE /tags/:id` — 软删，同时删关联

交易写入/更新时 body 可带 `tags: string[]`，服务端整体替换关联（先删后插，只保留本账本内存在的标签）。
`GET /transactions` 每项多 `tags: string[]`、`tag_names: string[]`。

### 2.3 预算（结转）

`GET /budgets?month=YYYY-MM` 出参每项增加：

```
rollover: 0|1,
carry_in_cents: 上月结转进来的金额（可正可负）,
available_cents: amount_cents + carry_in_cents,
remaining_cents: available_cents - used_cents
```

顶层汇总也增加 `carry_in_cents`、`available_cents`。

**结转算法**：设某预算项 `B` 的月额度为 `A(m)`，结转开关 `R`：
`carry(m) = R ? (A(m-1) + carry(m-1) - spent(m-1)) : 0`，从该项**最早出现的月份**递推到目标月（最多回溯 36 个月，防死循环）。
允许负结转（超支下月扣减）。`PUT /budgets` body 增加 `rollover: 0|1`。

### 2.4 周期记账

- `GET /recurring` → `{items:[...]}`，每项含规则字段 + `due: boolean`（next_run <= 今天）
- `POST /recurring` / `PATCH /recurring/:id` / `DELETE /recurring/:id`（软删）
  body: `{id?, type, amount_cents, category_id?, account_id?, to_account_id?, note?, freq, interval?, start_date, end_date?, enabled?}`
  `next_run` 由服务端按 `start_date` 初始化；`PATCH` 改 `freq/interval/start_date` 时重算 `next_run`（若已生成过则从 `last_run` 之后算）。
- `POST /recurring/run` — `{ date?: 'YYYY-MM-DD' }`（默认今天）
  把所有 `enabled=1 AND next_run <= date` 的规则依次生成交易，返回 `{ created: [...], skipped: [...], rules: [...] }`。
  **幂等**：生成交易的 `external_id = 'rec:' + ruleId + ':' + 该次执行日期'`，`source='auto'`；已存在则跳过并推进 `next_run`。
  一次 `run` 对一条规则最多补生成 **60** 条（防止 start_date 设到几年前把库灌爆），超出部分只推进不生成，并在 `skipped` 里说明。

推进规则：`daily` +interval 天；`weekly` +interval*7 天；`monthly` +interval 月（月末日期夹取，如 1/31 → 2/28）；`yearly` +interval 年。
`end_date` 之后不再生成，`next_run` 置为 `end_date` 且 `enabled` 不变（前端显示"已结束"）。

### 2.5 报销

- `POST /transactions/:id/reimburse` `{ account_id, date?, amount_cents? }`
  把原交易 `reimburse_state='pending'→'done'`、`reimburse_at=date`，并生成一条 `type='income'` 的入账交易：
  `amount_cents` 默认等于原交易金额、`category_id=null`、`note='报销：' + 原备注`、`external_id='reimb:'+原交易id`（幂等）。
  返回 `{ transaction: 原交易, income: 新交易 }`。原交易已是 `done` → 409 `already_reimbursed`。
- `PATCH /transactions/:id` body 可带 `reimburse_state`（`null`/`pending`/`done`），用于标记/取消待报销。
- `GET /stats/reimburse?ledger_id&from&to` → `{ pending_cents, pending_count, done_cents, done_count, items:[...] }`

### 2.6 统计与筛选

**统一筛选参数**（下面所有 `/stats/*` 和 `GET /transactions` 都支持）：

`from=YYYY-MM-DD&to=YYYY-MM-DD&type=expense|income|transfer|adjust&account_id=&category_id=&tag_id=&q=关键词&min_cents=&max_cents=`

`account_id` 匹配 `account_id` 或 `to_account_id`；`q` 对 `note` 做 `LIKE %q%`。

新增端点：

| 端点 | 出参 |
|---|---|
| `GET /stats/overview?from&to` | `{ income_cents, expense_cents, net_cents, count, days, avg_expense_cents, max_expense_cents, max_expense_note, by_weekday:[7]{weekday,expense_cents,count}, by_type:{expense,income,transfer,adjust} }` |
| `GET /stats/by-account?from&to&kind=expense\|income` | 裸数组 `[{account_id,name,icon,type,amount_cents,ratio}]`（转账不计入） |
| `GET /stats/by-tag?from&to` | 裸数组 `[{tag_id,name,color,amount_cents,ratio}]`（只统计支出，无标签交易归 `tag_id:null,name:'未打标签'`） |
| `GET /stats/compare?from&to` | `{ current:{...summary}, previous:{...summary}, delta:{income_pct,expense_pct,net_cents} }`，previous = 等长的前一个区间 |
| `GET /stats/calendar?month=YYYY-MM` | 裸数组 `[{date:'YYYY-MM-DD',expense_cents,income_cents,count}]`，只返回有数据的日期 |

已有端点增量：
- `/stats/by-category`、`/stats/trend` 支持全部筛选参数；`by-category` 每项多 `count`。
- `/stats/trend?granularity=day|week|month`（原来只有 day/month），出参不变 `[{bucket,expense_cents,income_cents}]`。
- `/stats/summary` 增加 `net_cents`、`transfer_cents`、`adjust_cents`。

### 2.7 导入导出

- 导出 JSON 增加 `tags`、`recurring`、`transaction_tags`；CSV 增加两列 `标签`、`报销状态`。
- 导入保持幂等（`stableId` 已做），需兼容 v1.1 新字段：缺字段按默认值处理。

---

## 3. 前端页面与交互（web/）

Tabbar 仍是 4 个：记账 / 明细 / 报表 / 我的。新增页面都从「我的」进。

| 路由 | 页面 | 要点 |
|---|---|---|
| `#/assets` | **资产总览**（替代原 `#/accounts`） | 顶部渐变卡：净资产大数字 + 总资产/总负债两行；下面按 `kind` 分两组（资产 / 负债），组内每账户一行：图标+名称+类型标签+余额（负债显示为红负数）+ 占比细条；组尾小计。右上「+」新建账户。点账户 → 编辑面板（名称/类型/所属/额度/是否计入净值/余额调整/删除）。 |
| `#/recurring` | **周期记账** | 列表：图标+备注+「每月 5 日 · ¥xx」+ 下次日期 + 开关；点开编辑；底部「立即补记」按钮调 `run`。 |
| `#/tags` | **标签管理** | 标签 chips 列表 + 新建/改名/删除，显示使用次数。 |
| `#/budgets` | 预算（改造） | 每项：分类名 + 进度条 + 「已用 / 可用」；开启结转的显示 `含结转 ±¥x`；顶部总预算同理；编辑面板加「结转下月」开关。 |
| `#/report` | 报表（大改） | ① 筛选条（横向滚动 chips）：本月/上月/近30天/今年/自定义 + 「筛选」按钮打开面板（类型、账户、分类、标签、关键词、金额区间）。② 概览卡：收入/支出/净额 + 日均、最大单笔、笔数。③ 环形图切换：分类 / 账户 / 标签。④ 趋势图：日/周/月粒度 × 支出/收入切换。⑤ 环比卡：本期 vs 上期。⑥ 日历热力（当月）。 |
| `#/list` | 明细（改造） | 顶部加筛选入口（复用报表的筛选面板）；支持标签 chip 显示；`待报销` 徽章；长按/侧滑菜单增加「标记待报销」「确认报销」。 |
| `#/me` | 我的（改造） | 菜单项改为：资产 `#/assets`、周期记账、标签、预算、分类、数据、同步、关于；顶部显示净资产。 |

记账页（`#/add`）增加：**标签选择行**（chips，可新建）、**待报销开关**（仅支出）。

### 本地存储（store-local.js）同步要求

新增 object store：`tags`、`transaction_tags`、`recurring_rules`；`accounts` 记录多 `kind/credit_limit_cents`；`transactions` 多 `reimburse_state/reimburse_at/tags`。
`Store` 适配器接口新增方法（LocalStore / ApiStore 都实现）：

```
listTags() createTag(t) updateTag(t) deleteTag(id)
listRecurring() saveRecurring(r) deleteRecurring(id) runRecurring(date)
listAssets()                       // { items, totals }
adjustAccount(id, targetCents, note, date)
reimburse(txId, { accountId, date, amountCents })
statsOverview(range, filters) statsByAccount(range, kind, filters)
statsByTag(range, filters) statsCompare(range, filters) statsCalendar(month, filters)
```

DB 版本号 IndexedDB `open(name, 2)` 升级时补齐新 store，老数据不能丢（onupgradeneeded 里只建缺的）。

---

## 4. 验收清单

**后端**（`node test/smoke.mjs` 必须 ≥ 90 条断言全过）：
- [ ] 迁移幂等：连跑两次启动不报错，旧库（已有 demo 数据）能读
- [ ] 账户 kind 聚合：Σasset − Σliability = net，`include_in_net=0` 不计入
- [ ] 余额调整：adjust 交易生成、余额等于 target、`/stats/summary` 的 expense 不变
- [ ] 预算结转：连续三个月（额度 1000，前两月各花 800/1200，rollover=1）→ carry_in 依次 0/+200/−200
- [ ] 周期记账：monthly 1/31 的规则在 2 月生成 2/28；重复 run 不重复生成；60 条上限生效
- [ ] 标签：重名 409；交易带 tags 写入与回读一致；删标签后交易仍可读
- [ ] 报销：pending→done 生成 income 且幂等；二次调用 409
- [ ] 筛选：`type/account_id/tag_id/q/min_cents` 各自生效且可组合
- [ ] 新统计端点返回形状与本文档一致
- [ ] v0.1 全部 50 条老断言仍通过（不回归）

**前端**（headless Chrome 430×900 跑通）：
- [ ] 资产页：3 个数字正确、分组小计正确、新建/编辑/删除账户、余额调整
- [ ] 预算：开结转后显示 `含结转 ±¥x`，可用额 = 额度 + 结转
- [ ] 周期记账：新建「每月 5 日 ¥35」→ 立即补记 → 明细出现记录，再点一次不重复
- [ ] 标签：记账时新建并选中 → 明细显示 chip → 报表按标签分组出现
- [ ] 报销：标记待报销 → 确认 → 生成收入 → 状态变已报销
- [ ] 报表：5 个筛选条件逐一生效；三种环形图切换；三种粒度趋势切换；环比数字正确
- [ ] `node --check` 全部 js 通过；无 console error；深色模式不破版
