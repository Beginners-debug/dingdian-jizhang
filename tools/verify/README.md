# tools/verify — 自测脚本（本机真跑过）

十四个脚本都只用 Node 内置模块 + 本机已装的 Chrome，不装任何依赖。

| 脚本 | 用途 | 用法 |
|---|---|---|
| `class-cov.cjs` | 找出 `app.js` 里用到、`styles.css` 里没定义的 class（防止新组件裸奔） | `node tools/verify/class-cov.cjs web/app.js web/styles.css`（输出 `used N missing M`，有缺失时 exit 1） |
| `cdp.mjs` | headless Chrome + CDP：打开页面、注入脚本、截图 | `node tools/verify/cdp.mjs <url> <out.png> [evalJsFile] [w] [h]`；环境变量 `CDP_INIT` 里的 JS 会在求值前先执行（例如 `localStorage.setItem('mintlite:onboarded','1')` 跳过引导层） |
| `lead-e2e.js` | v1.1 浏览器 E2E（26 条）：资产行/进度条/净资产、概览三格、环比、热力图、预算结转开关、待报销开关、四则运算、保存后 +1 行 | 作为 `cdp.mjs` 的第 3 个参数传入，结果以 JSON 打印 |
| `lead-e2e-v12.js` | v1.2 浏览器 E2E（23 条）：5 tab 顺序、6 个资产分组、折叠写 `localStorage`、隐藏组 + 隐藏入口、还款提醒文案、账本下拉、成员 chips/明细/报表、12 根月度柱、右滑返回、左滑切 tab | 同上 |
| `lead-server-mode.js` | 服务器模式页面复验（8 条）：UI 登录拿 token → 切服务器模式 → 资产页净资产 = 后端 `totals.net_cents` → 提醒条数与 `/accounts/reminders` 一致 → 明细可渲染 → 切回本地 | 同上，入口建议 `#/me/sync` |
| `idb-recover.js` | 复现并验证「IndexedDB connection is closing」修复（10 条）：把库模拟升级到 v3 → 旧连接自动让位 → 真实 UI 新增分类成功、数据落库、版本不降级、列表即时出现 | 作为 `cdp.mjs` 的第 3 个参数传入 |
| `api-v11.mjs` | v1.1 接口契约复核（27 条）：login / overview / compare / calendar / by-account / by-tag / accounts totals / budgets 结转 / recurring 幂等 / health | 先起服务（默认 8787），再 `node tools/verify/api-v11.mjs`；`BASE=http://127.0.0.1:9000` 可改地址 |
| `lead-e2e-v121.js` | v1.2.1 真机三项（11 条）：账户记忆落键、键盘占比与分类溢出、`MintLiteBack()` 二级页返回、注入假桥后根页左滑触发 `exitApp()` | 作为 `cdp.mjs` 的第 3 个参数传入，建议 360×780 与 430×900 各跑一次 |
| `lead-e2e-import.js` | v1.2.2 导入导出 E2E（13 条）：选薄荷 TSV → 预览条数 → 确认 → 明细出现 → 同文件重导「跳过 N 条」 | 同上，入口 `#/me/data` |
| `lead-import-server.js` | 服务器模式导入（11 条）：UI 登录 → 切 server → 导入 5 行 → 两次导入合计只多 5 条 → 金额/USD 前缀 → 删干净 | 同上，需要 8787 在跑且 demo/demo1234 可用 |
| `api-mint.mjs` | v1.2.2 薄荷互导复核（36 条）：样本字节嗅探、2556 行落库、二次幂等、三类计数、成员/「未指定」账户、按分类名搜索、dry_run 不落库、mint 导出 19 列可回导 | `node tools/verify/api-mint.mjs`（自起 8803 + 临时库，读 `tools/verify/fixtures/mint-sample.tsv`，可用 `MINT_SAMPLE=` 换样本） |
| `lead-e2e-v13.js` | v1.3 前端 E2E（35 条）：周期开关暂停后行仍在 + 「已暂停」徽标 + 库内 `ledger_id/amount_cents/next_run` 未变、短按 200ms 不弹长按 600ms 弹面板、编辑表单无删除按钮、暂停规则补记不产流水、明细预算条与展开记忆、种子库总预算仍 4500、改分类总预算不变、超预算弹二选一、未分配编辑 | 作为 `cdp.mjs` 的第 3 个参数传入，建议 430×900 |
| `lead-e2e-budget-switch.js` | 预算总开关 22 条（默认关闭 → 开启 → 明细出现预算条 → 关掉 → 消失 → 重进仍关闭） | `node tools/verify/cdp.mjs "http://127.0.0.1:8787/" .tmp/b.png tools/verify/lead-e2e-budget-switch.js 430 900` |
| `lead-e2e-credit-fields.js` | v1.3.1 信用字段条件显示（21 条）：银行卡编辑不显示额度/账单日/还款日、切信用卡后出现且所属转负债、切回隐藏并清空、保存后库内三项为 0、信用卡三项在且带出额度 | 作为 `cdp.mjs` 的第 3 个参数传入，入口 `#/assets` |
| `api-v13.mjs` | v1.3 接口契约复核（42 条）：迁移到 `user_version=4`、分类保存不动总预算、`budget_below_allocated` 409 与 details、rebalance 最大余数法不丢分、`unallocated_cents` 入参、warn 三态与 `none`、`PATCH /recurring` 只改 enabled 不清空其它字段 | `node tools/verify/api-v13.mjs`（自起 8805 + 临时库） |
| `api-v12.mjs` | v1.2 接口契约复核（30 条）：自起 8801 + 临时库，覆盖分组派生 / totals 自洽 / 还款日与隐藏 / 成员 CRUD 与 409 / `member_id` 过滤 / 提醒四级 / by-member 与 monthly 数组 / 新建账本 / 最后一本不可删 | `node tools/verify/api-v12.mjs`（不依赖已在跑的服务，自己拉一个） |

## 跑一遍全套

```powershell
cd server; node src/server.js                     # 另开一个窗口，保持运行
node tools/verify/api-v12.mjs                     # 期望 PASS 30/30（自带临时库，不碰真实库）
node tools/verify/api-v11.mjs                     # 期望 PASS 27/27
node tools/verify/class-cov.cjs web/app.js web/styles.css   # 期望 used 286 / missing 0
$env:CDP_INIT="localStorage.setItem('mintlite:onboarded','1')"
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/add" ".tmp/e2e12.png" "tools/verify/lead-e2e-v12.js"     # 期望 23/23
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/me/sync" ".tmp/server.png" "tools/verify/lead-server-mode.js"  # 期望 8/8
node tools/verify/cdp.mjs "http://127.0.0.1:8787/" ".tmp/idb.png" "tools/verify/idb-recover.js"             # 期望 10/10
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/add" ".tmp/e2e121.png" "tools/verify/lead-e2e-v121.js" 360 780   # 期望 11/11
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/me/data" ".tmp/import.png" "tools/verify/lead-e2e-import.js"    # 期望 13/13
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/me/data" ".tmp/impsrv.png" "tools/verify/lead-import-server.js" # 期望 11/11
node tools/verify/api-mint.mjs                     # 期望 PASS 36/36
node tools/verify/api-v13.mjs                      # 期望 PASS 42/42
node tools/verify/cdp.mjs "http://127.0.0.1:8787/#/assets" ".tmp/credit.png" "tools/verify/lead-e2e-credit-fields.js"   # 期望 21/21
node tools/verify/cdp.mjs "http://127.0.0.1:8787/" ".tmp/e2e13.png" "tools/verify/lead-e2e-v13.js" 430 900   # 期望 35/35
```

## 注意

- `lead-e2e*.js` 走**本地 IndexedDB** 模式，每次跑都是全新 profile（种子数据重建），所以断言里的数字（v1.2 净资产 ¥30,425.30、明细 5 行）是种子数据的固定值。
- `lead-server-mode.js` 需要 `demo/demo1234` 与真实库（`server/data/mintlite.db`，v4 迁移后 9 账户 25 流水）；它跑完会切回本地模式，不把演示环境留在服务器模式。
- 记账页保存前必须先点一个分类，否则 `saveTransaction()` 会拦下并提示「先选一个分类」——脚本里已处理。
- `api-v12.mjs` 用 `import.meta.url` 定位项目根，从任何目录调用都行（早期用 `process.cwd()` 会 `spawn node ENOENT`）。
- Chrome 路径写死在 `cdp.mjs` 里（`C:/Program Files/Google/Chrome/Application/chrome.exe`），换机器要改。
