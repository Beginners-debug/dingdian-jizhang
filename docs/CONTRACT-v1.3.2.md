# CONTRACT v1.3.2 —— 预算功能总开关

> 唯一权威规格。写入边界：`server/` 归 backend-api，`web/` 归 web-pwa，`android/` 归 android-shell，`docs/`+`tools/`+`README.md` 归 Lead。

## 0. 用户原话与问题

> 「还有一个问题，我预算都没有开启，为啥明细会显示预算呢，我预算开关都没打开，所以这一部分关联你没做好。」

现状：预算页标题右侧有一个开关，但那个开关是**结转下月**（rollover），不是「预算功能开关」。用户以为自己没开预算，明细页顶部却出现「本月预算 ¥4,500.00」，观感就是「关联没做好」。种子数据还预置了 4500，进一步加深误会。

结论：**缺一个真正的总开关**。补上，并把结转开关从标题挪到有文字标签的行里，避免再被误认。

## 1. 语义

- 预算功能按**账本**开关，字段 `ledgers.budget_enabled`（0/1），默认 **0（关闭）**。
- 关闭时：明细页**完全不渲染**预算条（连「未设本月预算 ›」入口也不出现）；预算页只显示一张「预算功能没开启」的卡片 + 「开启预算」按钮，其余输入全部不渲染。
- 开启时：一切按 v1.3 的行为（预算条 / 等式模型 / 预警阈值 / 结转）。
- 关闭不删数据：`budgets` 行原样保留，重新开启即恢复。
- 只要通过接口/界面写入任意一条 `amount_cents > 0` 的预算，服务端自动把该账本 `budget_enabled` 置 1（避免「设了预算却看不到」）。

## 2. 服务端

1. `server/src/db.js`：迁移 `user_version` 4→5，`ALTER TABLE ledgers ADD COLUMN budget_enabled INTEGER NOT NULL DEFAULT 0`（幂等，走现有 `addColumn` 助手）；`seedDemo()` 的账本显式 `budget_enabled = 0`；`POST /ledgers` 新账本写 0。
2. 账本出参（`GET /ledgers`、`POST /ledgers`、`PATCH /ledgers/:id`）都带 `budget_enabled`（**0/1 数字**，与 `is_default/archived` 一致）。
3. `GET /budgets` 出参新增 `enabled`（0/1，取自账本）。
4. `PUT /budgets`：
   - 接受 `enabled: true|false|1|0`，只改账本标志，不动预算行；返回 `budgetView()`（含新的 `enabled`）。
   - 允许 `{ledger_id, month, enabled}` 这种「只有开关」的请求。
   - 写入 `amount_cents > 0` 时若账本当前关闭 → 自动置 1（响应 `enabled: 1`）。
5. `server/test/smoke.mjs` 至少新增：新账本 `budget_enabled === 0`；`GET /budgets` 的 `enabled === 0`；`PUT /budgets {enabled:true}` → `enabled === 1` 且再 GET 仍 1；`PUT /budgets {enabled:false}` → 0；`PUT /budgets {amount_cents:500000}` 在关闭状态下自动变 1。

## 3. 前端

1. `web/app.js` `budgetStripHtml()` / `renderListPage()`：`view.enabled` 为假时**返回空字符串**，明细页不出现 `[data-block="budget-strip"]`。
2. `web/app.js` `renderBudgetsPage()`：
   - 关闭时整页只渲染：`subHeader('预算')` + `<div class="card" data-block="budget-off">` 标题「预算功能没开启」、说明「开启后，明细页顶部会出现本月预算条；分类预算和预警阈值也在这里设。」、按钮 `data-act="budget-enable-on"` 文案「开启预算」。
   - 开启时：总预算卡片顶部一行开关 `<label class="switch"><input type="checkbox" data-act="budget-enable" checked><i></i></label>` + 文案「预算功能」，副文案「关闭后明细页不显示预算条，已填的数据保留」。
   - 结转开关从 `<h3>` 里挪出来，改成卡片内一行：`结转下月` + `switch tiny`（`data-roll` 不变）+ 提示「把本月剩下的钱带到下个月」。
3. `web/js/store-local.js`：`getBudgets()` 出参补 `enabled`（读账本 `budget_enabled`，缺省 0）；`setBudget({enabled})` → `updateLedger(ledgerId,{budget_enabled: 1|0})`；写入 `amount_cents>0` 时同样自动置 1。`web/js/seed.js` 的账本对象加 `budget_enabled: 0`。
4. `web/js/store-api.js`：`getBudgets` 透传 `enabled`；`setBudget` 把 `enabled` 放进请求体。
5. 版本：`web/app.js`、`web/sw.js` 的 `VERSION = '1.3.2'`。

## 4. 验收

- 服务端：`node server/test/smoke.mjs` 全绿（含上述 5 条新断言）。
- 前端（Lead 的 `tools/verify/lead-e2e-budget-switch.js`）：全新 profile → 明细页无预算条 → 预算页有「开启预算」→ 点开启 → 明细页出现「本月预算 ¥4,500.00」→ 回预算页关掉 → 明细页预算条消失 → 刷新后仍是关闭。
- 回归：`lead-e2e-v13.js`（预算相关断言需按新开关调整：先开启再断言条）、`lead-e2e-v12.js` 23/23、`class-cov` missing 0、`node --check` 全过。
