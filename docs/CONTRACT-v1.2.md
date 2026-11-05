# MintLite v1.2 契约（唯一权威规格）

> 目标：把「资产」提到一级入口，做出能折叠/能隐藏/能提醒还款的资产体系；加多账本切换；把「成员」这一维度从记账到报表打通（**只做本地，多用户登录与联网同步本轮不做**，但字段与筛选先留好）；补滑动返回/切页手势；报表按薄荷记账的版式补强。
> 约定：金额一律整数分 `amount_cents`；id 客户端生成 UUID；软删除 `deleted_at`；本地 IndexedDB 与服务器 REST 行为必须一致（前端 `LocalStore` / `ApiStore` 双实现）。

---

## 1. 目标 / 非目标

**做**
1. 底部导航 5 个一级 tab：`记账 / 明细 / 资产 / 报表 / 我的`（资产从「我的」里挪出来）。
2. 资产页按**大类分组**（现金、储蓄卡、电子钱包、投资、应收、应付、信用卡/信用付），每组可折叠（`v` 形箭头）、可显示/隐藏（眼睛），组头显示小计；账户行也支持单独隐藏；底部「N 个隐藏账户」可展开查看。
3. 信用卡/信用付类账户支持**账单日 `bill_day` / 还款日 `repay_day`**（1–31），资产页顶部与「我的」显示**还款提醒**（距还款日 X 天 / 今天到期 / 已逾期 N 天 + 应还金额）；点击可跳到该账户明细。
4. **多账本**：顶部账本切换器（下拉），支持新建/重命名/删除/设为默认；切换后所有页面数据跟着切。
5. **成员维度**：新增 `members`（账本内成员，含「我」）；记账时可选成员（默认「我」）；明细可按成员筛选；报表新增「成员」维度（按人看某月花了多少）。
6. **手势**：右滑（从屏幕左缘起）返回上一页；一级 tab 页左右滑动切换 tab；底部弹层下滑关闭；不干扰横向滚动的控件。
7. **报表补强**：分类环形图带外置标签+指引线；新增「月度收支」近 12 月双序列柱状图；新增「统计面板」入口网格（可跳转到各报表）；筛选 chips 增加「成员」。

**不做（本轮）**
- 多用户登录 / 邀请共享 / 联网实时同步 / 云端账号体系。
- 商家库、项目（报销单）、分期、存钱计划、桌面小组件、指纹锁。

---

## 2. 数据模型增量

### 2.1 accounts（本地 object store `accounts` / 服务端表 `accounts`）
| 字段 | 类型 | 说明 |
|---|---|---|
| `bill_day` | int? 1–31 | 账单日；信用类才有 |
| `repay_day` | int? 1–31 | 还款日；信用类才有 |
| `hidden` | 0/1 | 默认 0；隐藏后不在常规列表出现，只在「N 个隐藏账户」里 |
| `sort` | int | 组内排序，默认按创建顺序 |
| `group` | string | **只读派生**，由 `type` 映射：`cash→cash`、`bank→bank`、`ewallet→ewallet`、`invest→invest`、`receivable→receivable`、`payable→payable`、`credit→credit`、`other→other`。前端不要自己再算一遍，服务端出参带 `group` |
| `kind` | `asset`\|`liability` | 已有：credit/payable = liability，其余 asset |

分组显示顺序固定：`cash, bank, ewallet, credit, invest, receivable, payable, other`；组标题：现金 / 储蓄卡 / 电子钱包 / 信用卡·信用付 / 投资 / 应收 / 应付 / 其他。

### 2.2 ledgers
已有 `id, user_id, name, currency, created_at, updated_at`；新增 `is_default`(0/1)、`archived`(0/1)、`sort`。删除账本 = 软删除（`deleted_at`），其下数据不再列出但保留。

### 2.3 members（新表 / 新 object store）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | |
| `ledger_id` | uuid | |
| `name` | text | 「我」「老婆」… |
| `color` | text | `#rrggbb`，用于明细小圆点/报表色块 |
| `is_self` | 0/1 | 每账本恰好一条 =1 |
| `sort` | int | |
| `created_at` / `updated_at` / `deleted_at` | iso / null | |

首启 seed 每个账本插一条 `{name:'我', is_self:1, color:'#2f9e8f'}`。

### 2.4 transactions
新增 `member_id`（uuid，可空；空 = 「我」）。其余不变；`external_id` 幂等规则不变。

### 2.5 迁移
- 本地：`DB_VERSION 2 → 3`，新建 `members` store（索引 `ledger_id`、`ledger_self`），`onupgradeneeded` 幂等；已有交易批量回填 `member_id = 该账本 is_self 成员 id`（在 `_migrate()` 里做一次，带 `meta` 标记 `migrated:v3`）。
- 服务端：`PRAGMA user_version` 2 → 3；`ALTER TABLE accounts ADD COLUMN bill_day/repay_day/hidden/sort`；`ALTER TABLE ledgers ADD COLUMN is_default/archived/sort`；`ALTER TABLE transactions ADD COLUMN member_id`；`CREATE TABLE members`；回填同上。全部 `IF NOT EXISTS` / 容错写法，重复执行不报错。

---

## 3. 接口增量（`/api/v1`，都带 `?ledger_id=`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts?ledger_id=` | 出参 `{items:[…], total, hidden_count, totals:{asset_cents,liability_cents,net_cents}, groups:[{key,title,count,subtotal_cents,hidden_count}]}`；每项带 `group/bill_day/repay_day/hidden`（金额字段统一 `_cents` 后缀） |
| PATCH | `/accounts/:id` | 可改 `name/type/kind/credit_limit_cents/bill_day/repay_day/hidden/sort/initial_cents`；非法日号 400 `invalid_day` |
| POST | `/accounts/:id/adjust` | 余额调整：`{target_cents}` 或 `{delta_cents}`，插 `type=adjust` 流水，不计收支与笔数（v1.2 附带实现） |
| GET | `/accounts/reminders?ledger_id=` | `{items:[{account_id,name,type,used_cents,credit_limit_cents,bill_day,repay_day,due_date,days_left,status:'overdue'\|'today'\|'soon'\|'later'}]}`；`days_left` 负数=逾期；只返回 `kind=liability` 且 `used_cents>0` 的账户，按 `days_left` 升序 |
| GET | `/ledgers` | 返回 `{items:[…]}`（保持现状也要兼容裸数组：`?legacy=1`） |
| POST | `/ledgers` | `{name,currency}` |
| PATCH | `/ledgers/:id` | `{name,is_default,archived,sort}` |
| DELETE | `/ledgers/:id` | 软删除；不允许删最后一个账本（409） |
| GET | `/members?ledger_id=` | `{items:[…]}` |
| POST | `/members` | `{ledger_id,name,color,is_self?}` |
| PATCH | `/members/:id` | `{name,color,sort}` |
| DELETE | `/members/:id` | 软删除；`is_self` 不可删（409）；其交易 `member_id` 置空 |
| GET | `/transactions?…&member_id=` | 列表新增 `member_id` 过滤，出参每项带 `member_id`、`member_name` |
| POST/PATCH | `/transactions` | 接受 `member_id`（可空） |
| GET | `/stats/by-member?from=&to=` | 裸数组 `[{member_id,member_name,color,expense_cents,income_cents,count}]` |
| GET | `/stats/overview` | 加 `by_member_top`：`[{name,expense_cents}]` 前 3 |
| GET | `/stats/monthly?months=12` | 裸数组 `[{month:'2026-11',expense_cents,income_cents}]`，按月份升序，缺月补 0 |
| 全部 `/stats/*` + `/transactions` | — | 统一接受 `member_id` 过滤 |

错误沿用 `{error:{code,message}}`：401 未登录、403 非本账本、404 不存在、409 冲突（删最后一个账本 / 删 is_self 成员 / 重名）。

---

## 4. 页面与交互

### 4.1 底部导航（5 tab）
`#/add 记账` · `#/list 明细` · `#/assets 资产` · `#/report 报表` · `#/me 我的`。图标沿用现有线性风格；选中态用主色。`#/me` 里的「资产」「账户」入口删除，改成「账本」「成员」。

### 4.2 资产页 `#/assets`
- 顶部 hero：净资产大数字 + 资产/负债两列 + 「资产趋势」小折线（近 6 月净值，可无数据）。
- 还款提醒条（有则显示，最多 3 条）：`花呗 应还 ¥1,082.00 · 距还款日 3 天`；逾期 `已逾期 2 天` 用危险色。点击进该账户明细。
- 分组列表：组头 `现金 · 3 个` + `¥1,234.00` + 右侧 `v` 箭头（点击折叠，状态存 localStorage `mintlite:asset-collapsed`）；组内账户行：图标/名称/类型胶囊/金额（负债显示负数）。信用卡行下方显示额度条 + `已用 ¥x / 额度 ¥y`。
- 隐藏：组头右侧眼睛图标切整组显示/隐藏；账户行左滑或长按出菜单（隐藏/编辑）。隐藏项收进底部「N 个隐藏账户」折叠区。
- 右下浮动 `＋` → 新增账户表单（含类型选择、初始余额、额度、账单日/还款日）。

### 4.3 账本切换
记账/明细/资产/报表四页的页面标题左侧放账本名 + `v`（下拉列出所有账本 + 「新建账本」「管理账本」）。切换后写 `localStorage['mintlite:ledger']` 并刷新当前页数据。

### 4.4 成员
- 记账页分类/账户下方加一行成员 chips（默认「我」选中）；`transactions.member_id` 写入。
- 明细页筛选「更多」里加「成员」。
- 报表：`概览` 下加「成员」卡片（前 3 名 + 占比条）；统计面板加「成员分布」。
- 「我的 → 成员」页：列表 + 新增/改名/改色/删除（is_self 不可删）。

### 4.5 报表
- 分类统计：环形图外置标签 + 指引线，显示 `分类 32.5%`。
- 日趋势：保持现有双态（支出/收入），柱状+折线切换不变。
- 月度收支：近 12 月，支出柱向下/收入柱向上（或双色并排），带 `-1.8w` 这类缩写。
- 统计面板网格：`分类占比 / 日趋势 / 月度收支 / 账户分布 / 标签分布 / 成员分布 / 日历热力 / 环比 / 预算执行 / 待报销`，点击跳到对应区块（锚点滚动）。
- 筛选 chips：时间范围、成员、账户、分类、标签。

### 4.6 手势
| 手势 | 行为 |
|---|---|
| 右滑（起点 x < 40px，横向位移 > 80px 且 |dx| > 2|dy|） | `history.back()`；已在 tabbar 根页则忽略 |
| tabbar 页左右滑动（位移 > 60px，|dx| > 2|dy|，非表格/图表/横向滚动容器内） | 切到相邻 tab |
| 底部弹层下滑（位移 > 90px 且向下） | 关闭弹层 |
| 列表项左滑 | 露出「编辑 / 删除」按钮（明细、账户、标签、成员） |

实现要求：用 `pointerdown/pointermove/pointerup`，`touch-action: pan-y` 只加在可滑区域，不劫持 `<input>`、`<canvas>`/`svg` 图表、`.hscroll` 横向容器。

### 4.7 提醒
- 开启条件：`kind=liability`、`used_cents>0`、有 `repay_day`。
- 计算：`due_date` = 本月还款日（若已过则下月），`days_left = due_date - today`。`<=0` 逾期/今天。
- 显示：资产页提醒条 + 「我的」页小红点。
- Android 壳：若存在 `window.MintLiteBridge.notify(title, body)`，在 `days_left<=3` 时调一次（每天最多一次，记 `localStorage`）。Web 上该桥不存在则跳过，不报错。

---

## 5. 验收（必须逐条可跑）

**接口**（`tools/verify/api-v12.mjs`，供 Lead 独立复跑）
1. `GET /accounts` 每项带 `group`，`totals.net = asset - liability`，`groups` 覆盖出现过的组。
2. `PATCH /accounts/:id` 改 `bill_day/repay_day/hidden` 生效且回读一致。
3. `GET /accounts/reminders` 对「花呗（used>0, repay_day 存在）」给出 `days_left` 数值与 `status`；改 `repay_day` 后结果跟着变。
4. `GET /ledgers` 至少 1 本；POST 新建后可列出；DELETE 最后一个 → 409；DELETE 非最后一个 → 之后列表少一本。
5. `GET /members` 至少 1 条 `is_self=1`；DELETE is_self → 409；新增成员后 `POST /transactions` 带 `member_id`，回读一致。
6. `GET /stats/by-member` 裸数组，`expense_cents` 之和 = `overview.expense_cents`（同筛选下）。
7. `GET /stats/monthly?months=12` 长度 12、升序、缺月补 0。
8. 旧接口不回归：smoke 105 条仍全过。

**前端**（`tools/verify/lead-e2e-v12.js`，Lead 独立跑）
1. 底部 5 个 tab 存在且顺序为 记账/明细/资产/报表/我的。
2. 资产页至少 5 个组头，点信用卡组头折叠后组内账户行消失，再点恢复（`localStorage` 记住）。
3. 眼睛图标隐藏整组后，组内账户进「N 个隐藏账户」。
4. 提醒条出现且文案含「距还款日」或「已逾期」，数字与接口/本地计算一致。
5. 账本下拉能列出 ≥2 本（新建一本后），切换后明细条数变化。
6. 记账页点「老婆」成员 → 保存 → 明细行显示该成员 → 报表「成员分布」出现「老婆」。
7. 报表有「月度收支」区块且柱子数 = 12。
8. 手势：在 `#/me` 进二级页后右滑能返回；`#/assets` 左滑切到 `#/report`。
9. `class-cov` → missing 0；`node --check` 全过；无 console error。

---

## 6. 写入边界（避免互相踩）

| 目录 | 负责人 |
|---|---|
| `server/**` | backend-api |
| `web/**` | web-pwa |
| `android/**` | android-shell |
| `docs/**`、`tools/**`、`README.md` | Lead（其他人只读） |

工具链、构建命令、验收脚本一律沿用 v1.1 现状，不新装依赖。
