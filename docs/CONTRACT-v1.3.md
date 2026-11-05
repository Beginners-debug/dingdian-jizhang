# CONTRACT v1.3 — 周期记账暂停/删除 + 预算条与预警

> 状态：**生效**。本文是 v1.3 的唯一权威规格，实现与验收以本文为准；与旧文档冲突时以本文为准。
> 目标版本：`1.3.0`（APK versionCode **8**）。基线：v1.2.3（APK `mintlite-20261105-0940.apk`）。

## 0. 用户原话与两条需求

> 「第一个就是周期记账，我发现我增加了周期记账，但是目前不需要周期记账了，但是后续我想要，我点击那个开关发现直接消失了我猜应该是删除了，我觉得不应该是直接删除应该是暂停或停止，长按才有删除选项。第二个就是预算，我认为预算应该再明细的最上面增加一行，显示预算还剩多少，如果设置了明细预算，还可以展开查看，对了明细预算之和要等于总预算哦，还需要一个预算预警提示预算少于10%了或者多少，这个用户可以设置。」

拆成两件事：

- **A. 周期记账**：开关 = 暂停/启用（不删除）；删除只能长按出现；已暂停的规则继续留在列表里，标「已暂停」，不参与补记。
- **B. 预算**：明细页顶部常驻一行预算（剩余 + 进度），设了分类预算可展开看明细；总预算与分类预算之和恒等；剩余比例低于用户设定阈值时预警（默认 10%，可改）。

## 1. 已确认的根因（A 的「消失」不是删除）

`web/js/store-local.js` 的 `saveRecurring()` 是**整体覆盖**语义：它用 `data` 里的字段直接拼一整行，没有 `id` 时取 `cur` 的旧值。前端开关调用的是 `store.saveRecurring({ id, enabled: 0 })`，于是：

| 字段 | 传进来的值 | 落库结果 |
|---|---|---|
| `ledger_id` | 未传 | **`undefined`** → `listRecurring(ledgerId)` 按 `ledger_id` 过滤，行直接消失 |
| `enabled` | `0` | `data.enabled === false ? 0 : 1` → `0 !== false` → **被写成 1**，暂停根本没生效 |
| `type` / `amount_cents` / `note` / `freq` / `next_run` … | 未传 | 回落 `'expense'` / `0` / `''` / `'monthly'` / 今天 |

服务端 `PATCH /recurring/:id` 是**合并**语义（`normalizeRule(body, existing)` 逐字段 `pick`），所以只有本地模式中招；这也是为什么「刷新也没回来」——行还在库里，只是 `ledger_id` 丢了，任何按账本的查询都看不到它。

## 2. 数据模型变更

### 2.1 `budgets` 新增 `warn_percent`

```sql
ALTER TABLE budgets ADD COLUMN warn_percent INTEGER NOT NULL DEFAULT 10;
```

- 服务端迁移：`PRAGMA user_version` 3 → 4，包在事务里，幂等（用 `pragma table_info` 判断列是否已存在）。
- 本地 IndexedDB：`DB_VERSION` 3 → 4，`budgets` 存量的 `category_id == null` 行补 `warn_percent = 10`。
- 语义：**只读总预算行**（`category_id IS NULL`）的值；分类行保留但忽略。取值 `1..100`，非法 400 `invalid_warn_percent`。

### 2.2 不变式：总预算 = Σ 分类预算（存在分类预算时）

- `PUT /budgets` 保存**分类**预算：**不动总预算行**。若总预算行存在且 `amount_cents > 0` 且新的 Σ > 总预算 → **409** `budget_below_allocated`，body `{error:{code,message,details:{total_cents,categories_sum_cents}}}`；带 `rebalance:true` → 按比例把**各分类**缩到总预算内（**最大余数法**，Σ 精确 = 总预算），返回 200。
- `PUT /budgets` 保存**总**预算：`amount_cents < Σ` → 同上 409（带 `rebalance:true` 则把分类按比例缩到新总额）；否则直接写。
- 可选入参 `unallocated_cents`（整数 ≥ 0）：写入总预算 = `Σ + unallocated_cents`（没有总预算行就新建），供前端直接编辑「未分配」。
- 分类预算金额改成 0 = 删除该分类预算行（沿用 v1.1 语义）。
- 迁移不修改既有数据；`unallocated_cents` 暴露差额，UI 以等式展示（`总预算 = 明细合计 + 未分配`）并给「对齐到明细合计」按钮（= 把总预算写成 Σ，`unallocated_cents` 归零）。
- **为什么不做「保存分类就把总预算改成 Σ」**：种子库（4500 / 明细 2300）与用户真实库都会在第一次编辑分类时被静默改小，演示还会直接变「超支」。等式模型既满足「之和等于总预算」（未分配 = 0 时严格相等），又不销毁用户输入的总额。

### 2.3 `budgetView` 出参（新增字段，旧字段不动）

顶层新增：

| 字段 | 说明 |
|---|---|
| `categories_sum_cents` | Σ 分类预算额度（不含结转） |
| `unallocated_cents` | `max(0, amount_cents − categories_sum_cents)` |
| `mismatch` | `unallocated_cents > 0`（**只是「有未分配余额」的状态，不是错误**，不影响 `warn_level`） |
| `warn_percent` | 总预算行的阈值，无总预算行时 10 |
| `percent_left` | `available_cents > 0 ? round(remaining_cents / available_cents × 100, 1) : 0`（可为负）；`warn_level = 'none'` 时为 `null` |
| `warn_level` | **无预算**（`amount_cents <= 0 && categories_sum_cents === 0`）→ `none`；否则 `remaining_cents < 0` → `over`；`percent_left <= warn_percent` → `warn`；其余 `ok` |

每个 `items[]` 同样补 `percent_left` / `warn_level`（分类行用同一套公式，`warn_percent` 取总预算行的值）。

## 3. 接口变更

| 方法 | 路径 | 变更 |
|---|---|---|
| `PUT` | `/budgets` | 接受 `warn_percent`、`rebalance`、`unallocated_cents`；分类保存不动总预算；`总预算 < Σ` → 409 `budget_below_allocated`（`rebalance` 可解） |
| `GET` | `/budgets` | 出参加 §2.3 全部字段 |
| `PATCH` | `/recurring/:id` | **不改**（已是合并语义）；补断言证明 `{enabled:0}` 不会清空其它字段 |
| `GET` | `/recurring` | 出参保留 `enabled`（0/1）与 `due`；已暂停的 `due` 恒 false（已有行为） |

## 4. 页面与交互

### 4.1 周期记账页（`#/recurring`）

- 行结构不变（`.rec-row`），已暂停行加 `.is-off` 并在副标题后加 `<span class="badge off">已暂停</span>`（类名 `.rec-off-badge`）。
- 右侧开关：`data-act="rec-toggle"`，切到关 = `saveRecurring({ id, enabled: 0 })`，toast「已暂停，随时可以再打开」；切到开 = toast「已恢复」。
- **长按 600ms** 行主体（`.rec-main`）→ 底部动作面板 `.sheet`：
  - 标题：规则名 + 金额
  - 按钮：`编辑`（`data-act="rec-edit"`）/ `暂停`·`恢复`（`data-act="rec-pause"`）/ `删除规则`（`data-act="rec-del"`，红色，需二次确认）
- 编辑表单里**移除**原来的「删除规则」大按钮（删除只走长按）。
- 长按实现要求：`pointerdown` 起 600ms 定时器，`pointerup`/`pointercancel`/`pointermove > 10px` 取消；触发后 `navigator.vibrate?.(10)`；不干扰点击（长按触发后吞掉紧随的 click）。

### 4.2 明细页预算条（`#/list`）

位置：`monthBar()` 之后、`.filter-bar` 之前，常驻。

```
[本月预算] ¥4,500.00   已用 ¥275.50 · 还剩 ¥4,224.50  [▾]
[=========================·                    ] 6%
```

- 容器 `[data-block="budget-strip"]`，`.bs-head`（标题 + 展开箭头 `[data-act="budget-strip-toggle"]`）、`.bs-amount`（总预算）、`.bs-left`（剩余，负数显示「超支 ¥X」）、`.bs-bar > i`（宽度 = 已用/可用，超 100% 封顶并加 `.over`）。
- `warn_level = warn` → 整条加 `.is-warn`（橙），`over` → `.is-over`（红），并在标题右侧加 `⚠️ 剩余不足 10%`（百分比取 `warn_percent`）。
- 未设预算 → 不显示整条（避免空占位）；显示为一行灰色提示 `未设本月预算 ›` 点击去 `#/me/budgets`。
- 展开（默认收起，`localStorage['mintlite:budget-strip-open']='1'` 记忆）：`.bs-cats` 列出**已设预算的分类**，每行 `.bs-cat[data-category-id]`：图标 + 名称 + `还剩 ¥X`（负数 `超支 ¥X`）+ 细进度条；按 `percent_left` 升序（最紧的在上）。超过 6 条时内部滚动。
- 数据来源：`store.budgetUsage(state.ledgerId, todayMonth())`，**与明细页当前筛选范围无关**（永远是本月）。

### 4.3 预算页（`#/me/budgets`）

- 总预算卡：
  - 有分类预算时，`[data-budget="total"]` 变 `readonly`，旁注「= 明细合计」，并提供 `[data-act="budget-clear-cats"]`「清空明细预算」。
  - `mismatch` 时显示提示条：`总预算 ¥4,500.00，明细只分配了 ¥2,300.00，还有 ¥2,200.00 未分配` + 按钮 `[data-act="budget-align"]`「对齐到明细合计」。
  - 新增一行：`预警阈值` `<input type="number" data-warn-percent min="1" max="100">` `%`，说明「剩余低于这个比例时提醒」。保存走 `PUT /budgets` 的 `warn_percent`。
- 分类卡：每行加「还剩 / 超支」文字 + `.is-warn` / `.is-over` 状态色。
- 保存分类预算**不改**总预算；若明细合计超过总预算，弹确认：`[data-act="budget-expand"]`「把总预算提到 ¥Σ」/ `[data-act="budget-rebalance"]`「按比例压缩明细」。
- 总预算卡显示等式：`总预算 ¥4,500.00 = 明细合计 ¥2,300.00 + 未分配 ¥2,200.00`，`未分配` 可编辑（`[data-budget="unallocated"]`，单位元，走 `unallocated_cents`）。

### 4.4 我的页

- 「预算」入口副标题加：`本月还剩 ¥4,224.50`；`warn_level !== ok` 时前面加 `⚠️`。

## 5. 验收（我本人独立跑，不采信队友自报）

**接口（`tools/verify/api-v13.mjs`，Lead 写，37 条）**
1. 迁移后 `user_version=4`，`budgets` 有 `warn_percent` 列，存量总预算行 = 10。
2. `GET /budgets` 有 `categories_sum_cents / unallocated_cents / mismatch / warn_percent / percent_left / warn_level`，且 `percent_left = round(remaining/available*100,1)`。
3. 保存分类预算 → **总预算不变**；`categories_sum_cents` = Σ，`unallocated_cents` = 总预算 − Σ。
4. 总预算改成小于 Σ 的值且不带 `rebalance` → 409 `budget_below_allocated`，`details` 两个数正确。
5. 同上带 `rebalance:true` → 200，Σ 精确等于新总额（最大余数法，不丢分），且各分类金额按比例。
6. `warn_percent=15` 落库并回显；`warn_percent=0` / `101` / `'abc'` → 400。
7. 阈值生效：把剩余压到 5% → `warn_level='warn'`；压成负数 → `over`；宽裕 → `ok`。
8. `PATCH /recurring/:id` 只传 `{enabled:0}` → 其它字段（`amount_cents/note/freq/next_run/ledger_id/type`）全部不变，`enabled=0`；`GET /recurring` 出参必须带 `ledger_id`（与本地 store 行结构一致）。
9. `GET /recurring` 里该规则仍在（不是删除），`due=false`；`POST /recurring/run` 不为它生成流水。
10. 零预算账本（新账本、无预算）→ `warn_level='none'`、`percent_left=null`；有支出也不算 `over`。
11. `unallocated_cents` 入参：写总预算 = Σ + 该值，回读 `unallocated_cents` 相等。
12. 老接口零回归：`GET /budgets` 旧字段（`amount_cents/carry_in_cents/available_cents/used_cents/remaining_cents/items[]`）都在。

**前端（`tools/verify/lead-e2e-v13.js`，Lead 写，14 条）**
1. `#/recurring`：开关关掉后行仍在，`.rec-off-badge` 文案「已暂停」，`localStorage` 无关（数据在库里）。
2. 刷新后仍在（证明不是渲染问题）。
3. 长按 700ms 出现 `.sheet`，含 `[data-act="rec-del"]`；短按 200ms 不出现。
4. 编辑表单里没有删除按钮。
5. 暂停的规则点「立即补记」不产生流水。
6. `#/list` 顶部 `[data-block="budget-strip"]` 存在，`.bs-left` 文案含「还剩」。
7. 点 `[data-act="budget-strip-toggle"]` → `.bs-cats` 出现，行数 = 已设预算分类数。
8. 阈值触发时 strip 有 `.is-warn` 或 `.is-over` 与 `⚠️`。
9. 未设预算的账本 → strip 不渲染数字（只显示「未设本月预算」入口）。
10. `#/me/budgets`：有分类预算时 `[data-budget="total"]` 只读。
11. 改一个分类预算保存 → 总预算数字同步变化（等值）。
12. `[data-warn-percent]` 改成 20 保存 → 重进页面仍是 20。
13. `mismatch` 场景点「对齐到明细合计」→ `unallocated_cents=0`。
14. 无 console error，`class-cov` missing = 0。

**回归**：smoke、api-v11 / api-v12 / api-mint、lead-e2e-v12 / v121×2 / import / import-server、class-cov、`node --check` 全绿。

## 6. 写入边界

| 目录 | 归属 | 备注 |
|---|---|---|
| `server/` | backend-api | 迁移、`PUT/GET /budgets`、smoke 断言 |
| `web/` | web-pwa | `store-local.js` 合并语义修复、周期页、明细预算条、预算页、`sw.js`/`app.js` 版本 |
| `android/` | android-shell | 版本号与打包（等 GO） |
| `docs/` `tools/` `README.md` | Lead | 契约、验证脚本、文档、截图 |

## 7. 版本与产物

- `web/sw.js`、`web/app.js`、`server/src/server.js` 的 `VERSION` 全部 `1.3.0`；`web/sw.js` 的 `CACHE` 名随版本走。
- `android/app/AndroidManifest.xml`：`versionCode="8"`、`versionName="1.3.0"`。
- APK：`android/dist/mintlite-<时间戳>.apk`，`assets/www` 与 `web/` 逐文件哈希必须全等。
