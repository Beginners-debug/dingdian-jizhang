# MintLite / 薄荷轻记 — 开发计划

> 自用记账 App。前端后端分离，先做能用的基础功能，为「自动记账」和「服务器同步」留口子，并预留 Web 端。
> 参考对象：**薄荷记账**（melandru.lonicera）。
> 版本：v0.1 计划 · 2026-11-04

---

## 一、先看清楚对手：薄荷记账有什么

从应用商店描述、小众软件推荐、少数派横评里扒出来的功能清单，按「要不要抄」分档：

| # | 薄荷记账的功能 | 说明 | 我们的档位 |
|---|---|---|---|
| 1 | **四则运算键盘** | 金额栏能直接 `12.5+3×2=`，不用切计算器 | **MVP 必做**（横评里它靠这个赢） |
| 2 | 快速选择分类 / 账户 | 记账页一屏内完成，不跳页 | **MVP 必做** |
| 3 | 多账本 | 日常 / 旅行 / 装修 分开 | **MVP 必做**（数据隔离靠 ledger_id） |
| 4 | 账户管理 | 现金、银行卡、信用卡、余额宝 | **MVP 必做**（信用卡余额为负） |
| 5 | 收入 / 支出 / 转账 | 转账不计收支 | **MVP 必做** |
| 6 | 明细列表 + 按日小计 | 按月分组、当日合计 | **MVP 必做** |
| 7 | 报表：分类占比、日/月趋势 | 环形图 + 折线 | **MVP 必做**（用 SVG/CSS 手画，不引图表库） |
| 8 | 预算（总预算 + 分类预算，可结转） | 超支变红 | **MVP** 做总预算+分类预算，结转放 v1.1 |
| 9 | 周期记账（房租、订阅） | 到点自动生成 | v1.1 |
| 10 | 报销管理 | 标记「待报销/已报销」 | v1.1（先加一个 `reimbursable` 标记字段占位） |
| 11 | 标签 | 一笔多标签 | v1.1 |
| 12 | 数据导入导出（CSV/JSON） | 迁移历史数据 | **MVP 必做**（自用最重要的保险） |
| 13 | 云同步 / 多设备 | 服务端 | v1.2（本期把 API 和同步协议先定好） |
| 14 | 多人共同记账 | 家庭账本 | v2（schema 里 ledger 加 `owner_id` + `members` 表即可扩展） |
| 15 | 投资记账（股票/基金/存款） | 持仓、收益 | v2（先只留 `invest` 账户类型） |
| 16 | **智能自动记账：截图 OCR** | 识别账单截图自动分类 | v2（预留 `source='auto'` + `external_id` 去重） |
| 17 | 极速账单导入（支付宝/微信账单） | 免模板解析 | v1.2（CSV 列名映射 + 关键词分类） |
| 18 | 安全解锁（密码/指纹） | | v1.2（壳层加 BiometricPrompt，或 Web 层 PIN） |
| 19 | 深色模式 | | **MVP**（跟随系统，纯 CSS） |
| 20 | 桌面小组件 | | v2（原生壳加 AppWidget，WebView 方案做不了） |

**结论**：MVP 就是 1–8 + 12 + 19，正好覆盖「一天记 3 笔、月底能看懂钱花哪了」这件事。剩下的按版本排，schema 一次性设计到位，避免以后改表。

---

## 二、第一问：APK 到底是怎么写出来的

### 2.1 APK 的本质

APK 就是一个 zip，里面固定几样东西：

```
mintlite.apk
├── AndroidManifest.xml   # 二进制 XML：包名、权限、入口 Activity、SDK 版本
├── classes.dex           # Java/Kotlin 编译后的字节码（Dalvik 格式）
├── resources.arsc        # 资源索引表（字符串、颜色、尺寸）
├── res/                  # 布局、图标、drawable
├── assets/               # 原样打包的任意文件（我们的网页就放这）
└── META-INF/             # 签名（v1/v2/v3）
```

从一行代码到能装的 APK，标准流水线是：

```
源码(.java/.kt/.dart)
  → 编译(javac/kotlinc/dart)      → .class / .dill
  → 转 dex(d8)                    → classes.dex
  → 资源编译(aapt2 compile/link)  → resources.arsc + 二进制 XML
  → 打包 + 对齐(zipalign)         → 未签名 apk
  → 签名(apksigner, keystore)     → 可安装 apk
  → adb install / 手动点击安装
```

**Gradle 只是把上面这些步骤自动化**（AGP 插件帮你调 aapt2/d8/apksigner），不是必需品。所以本机没装 Android Studio 也能出 APK —— 见 2.3。

### 2.2 三条路线，选哪条

| 路线 | 技术栈 | 优点 | 缺点 | 本机可行性 |
|---|---|---|---|---|
| **A. 原生** | Kotlin + Jetpack Compose + Room | 性能最好、能做桌面小组件/通知监听/无障碍（自动记账必需）、体验最像 App | 学习成本最高；要 Android Studio；改 UI 慢 | 需装 JDK+SDK+Gradle（约 2GB） |
| **B. Flutter** | Dart + Flutter | 一套代码出 Android/iOS/Web；UI 写起来快；生态好 | 包体 15MB+；自动记账这类系统能力仍要写原生插件；要装 Flutter SDK | 需装 Flutter+SDK（约 2.5GB） |
| **C. WebView 壳** | 网页(PWA) + 20 行 Java 壳 | **当天就能出 APK**；UI 改一行刷新即见；同一套代码就是 Web 端（正好"预留 WebDev"）；离线可用；包体 1MB | 需要 JS 桥才能碰系统能力；动画不如原生；桌面小组件做不了 | **只需 JDK + build-tools（约 700MB），不用 Gradle** |

**决策：本期走 C，架构上按 B/A 的可迁移方式组织。**

理由：
1. 你的诉求是「自己用 + 先做简单基础功能 + 预留 Web 端」。C 一次性满足三条，且今天就能装上手机开始记账。
2. 记账 App 的性能瓶颈在「列表渲染 + 聚合统计」，1000 条/月的量级 WebView 完全无压力（IndexedDB 索引查询是毫秒级）。
3. **自动记账**（v2）需要 `NotificationListenerService` / `AccessibilityService`，这三个字 WebView 干不了。但解法很干净：壳里加一个 Java 服务，把抓到的通知文本 `evaluateJavascript("window.MintLite.onBankSms(...)")` 喂给网页，业务逻辑仍在前端。**壳是壳，业务是业务**，不用重写。
4. 如果哪天想要原生手感，前端逻辑（数据模型、统计、分类规则）可以平移到 Flutter，因为契约已经写死了（`docs/CONTRACT.md`）。

### 2.3 本期 APK 的构建方式（无 Gradle 手搓）

```
android/
├── app/AndroidManifest.xml
├── app/src/com/mintlite/app/MainActivity.java   # WebView + assets 拦截
├── app/res/…                                    # 图标/主题/字符串
├── build.ps1                                    # 一键：同步 web/ → 编译 → 打包 → 签名
├── keystore/mintlite.jks
└── dist/mintlite-YYYYMMDD-HHmm.apk
```

`build.ps1` 的实际命令序列（等价于 Gradle 干的事）：

```powershell
aapt2 compile --dir app/res -o .build/res.zip
aapt2 link -o .build/base.apk -I $SDK/platforms/android-34/android.jar `
  --manifest app/AndroidManifest.xml -R .build/res.zip --java .build/gen `
  -A app/assets --min-sdk-version 24 --target-sdk-version 34
javac -encoding UTF-8 -source 17 -target 17 -bootclasspath $SDK/platforms/android-34/android.jar `
  -d .build/obj (所有 .java + .build/gen/**/R.java)
d8 --lib $SDK/platforms/android-34/android.jar --min-api 24 --output .build/dex (.build/obj/**/*.class)
# 把 classes.dex 塞进 base.apk（python zipfile）
zipalign -f 4 .build/base.apk .build/aligned.apk
apksigner sign --ks keystore/mintlite.jks --ks-pass pass:*** --out dist/mintlite.apk .build/aligned.apk
apksigner verify dist/mintlite.apk
```

装到手机：`adb install -r dist/mintlite.apk`，或把 apk 丢微信/网盘，手机点开允许「未知来源」。

> 签名的意义：Android 只认「同一个包名 + 同一个签名」为升级。**keystore 丢了就再也覆盖安装不了**，只能卸载重装（数据在网页 IndexedDB 里，卸载即清空）。所以：keystore 备份 + 定期导出 JSON，两件事都要做。

### 2.4 壳里最关键的一段：为什么不能用 file://

`file:///android_asset/index.html` 打开时，页面 origin 是 `null`，**localStorage / IndexedDB 不持久化**，Service Worker 也不可用 —— 记账数据会丢。

正确做法：`shouldInterceptRequest` 把 `https://appassets.androidplatform.net/*` 映射到 `assets/www/*`，页面就有了稳定的 https origin，存储全部正常，离线也能跑。这段代码是本项目的技术核心之一，`MainActivity.java` 里已实现。

### 2.5 以后要真上架 / 上原生时怎么迁

- 包名、签名不动 → 用户无感升级。
- WebView 壳换成 Flutter/Compose 时，**数据先导出 JSON**，新 App 首次启动导入（`/import` 接口就是为此准备的）。
- 自动记账服务（Java）可以先在壳里做，迁移时整段复制。

---

## 三、第二问：一个记账软件该怎么写

记账软件看着简单，坑全在「钱不能算错」和「数据不能丢」。下面按重要性排。

### 3.1 第一原则：金额只用整数分

```js
// 错：0.1 + 0.2 = 0.30000000000000004
// 对：10 + 20 = 30（分）
amount_cents: 2350   // ￥23.50
```

- 存储、传输、聚合、比较，全程 `int`。
- 只在「显示」和「用户输入」两个边界做 `÷100` / `×100`（`Math.round(parseFloat(x) * 100)`，别用 `toFixed` 截断）。
- 四则运算键盘也不能用 `eval` 浮点算，要写成「分」为单位的整数运算或定点小数（`web/js/money.js` 里是 tokenizer + 递归下降，`0.1+0.2` 出 `0.3`）。

### 3.2 数据模型（5 张表打天下）

```
ledger 账本 ─┬─ account 账户（现金/银行卡/信用卡/投资）
             ├─ category 分类（支出/收入，可二级）
             ├─ transaction 流水（支出/收入/转账）
             └─ budget 预算（按月，可指定分类）
```

三条硬规则：
1. **账本是隔离边界**。所有查询必须带 `ledger_id`，服务端还要校验 `ledger.user_id === 当前用户`（防越权，这是自建服务最容易被自己写漏的地方）。
2. **转账是两条腿**：`account_id` 出、`to_account_id` 进，`category_id` 为空，**不进收支统计**。写错这一条，报表永远对不上。
3. **账户余额是派生值，但要落库缓存**。每次写/改/删流水，在**同一个事务**里回滚旧影响、施加新影响；同时提供「按流水重算余额」的修复入口（数据导入后必用）。

### 3.3 记账页的状态机（体验的核心）

```
[支出|收入|转账]  ← 模式，切换时清空分类选择
      ↓
金额表达式缓冲区 "12.5+3×2"  ← 键盘输入，= 求值，保存取最终值
      ↓
分类（必选，转账不需要）→ 账户（必选）→ [转账时] 目标账户
      ↓
日期（默认今天）→ 备注（可选）
      ↓
保存 → 写库 → 更新账户余额 → toast → 金额清零、分类保留（连续记账）
```

细节决定好不好用：
- 分类宫格把**最近用过的 4 个**排最前（记在 `meta` 里，不用查库）。
- 保存按钮在金额为 0 时禁用。
- 编辑已有流水时，模式/分类/账户/日期全部回填，保存走 `update` 而不是 `insert`。
- 键盘按钮 ≥ 48px，`tabular-nums` 等宽数字，防误触。

### 3.4 报表怎么算（不要用前端 filter 硬扫全表）

| 报表 | 算法 | 索引 |
|---|---|---|
| 本月收支结余 | `SUM(amount) WHERE type IN (expense,income) AND happened_at BETWEEN` | `(ledger_id, happened_at)` |
| 分类占比 | `GROUP BY category_id`，`ratio = 该项 / 总支出` | 同上 + 内存排序 |
| 日/月趋势 | `GROUP BY strftime('%Y-%m-%d', happened_at)`，**缺失的桶补 0** | 同上 |
| 预算进度 | `已用 = SUM(该分类本月支出)`，`剩余 = 预算 - 已用` | 同上 |

数据量到 10 万条也够用；真慢了再加「月度汇总表」物化，别提前优化。

### 3.5 离线优先 + 同步（v1.2，但现在就要定协议）

```
本地 IndexedDB（唯一真相）
   ↓ 每次写：先写本地，立即渲染（0ms 反馈）
   ↓ 队列：{op:'upsert', table:'transactions', id, updated_at}
   ↓ 联网时批量 POST /sync（带 since 游标）
服务端 SQLite（备份 + 多设备）
   ↓ 拉取 since 之后的变更
   ↓ 冲突：updated_at 新者胜（本期规则，简单且够用）
```

关键设计：**id 由客户端生成**（UUID），这样离线新建的记录不需要「临时 id → 服务端 id」的映射表，补传天然幂等（`ON CONFLICT(id) DO UPDATE`）。这是本期已经落地的部分。

### 3.6 数据安全（自用也不能省）

- 每天首次打开自动导出一份 JSON 到「下载」目录（或 IndexedDB 里保留最近 7 份快照）。
- 服务端 `data/mintlite.db` 定期 `cp` 备份（`node:sqlite` 的 `backup()` 可以在线备份）。
- keystore 单独备份。
- 局域网同步走 http 无所谓（自己家网），但如果要在公网 VPS 上跑，**必须**加 HTTPS（Caddy/Nginx + Let's Encrypt 一行搞定）。

### 3.7 自动记账（v2）三条技术路径

| 路径 | 原理 | 覆盖面 | 难度 |
|---|---|---|---|
| **通知监听** | `NotificationListenerService` 读微信/支付宝/银行 App 的支付通知，正则提金额+商户 | 覆盖大部分扫码支付 | 中（需引导用户开权限） |
| **无障碍读屏** | `AccessibilityService` 读账单页面文本 | 覆盖 App 内账单详情 | 高（易被风控、维护累） |
| **截图 OCR** | 分享截图到本 App → 本地 OCR（ML Kit / PaddleOCR）→ 正则+分类模型 | 覆盖所有能截图的场景 | 中（薄荷记账走的就是这条） |
| 短信解析 | `READ_SMS` 读银行短信 | 覆盖银行卡消费 | 低（但 Android 对 SMS 权限审核严，自用 sideload 无所谓） |

推荐顺序：**短信 → 通知 → 截图 OCR**。三者最终都归一到同一个入口：`ingest({amount, merchant, time, source:'auto', external_id})`，前端只写一次去重+分类逻辑。本期已预留 `source` / `external_id` 字段和幂等 upsert。

---

## 四、里程碑

| 阶段 | 内容 | 交付物 | 状态 |
|---|---|---|---|
| **M0** | 契约冻结：数据模型 + API + 存储接口 | `docs/CONTRACT.md` | ✅ 已完成 |
| **M1** | 后端：Node + SQLite + 全部 REST + 冒烟测试 | `server/` | ✅ 已完成（smoke 105/105） |
| **M2** | 前端：PWA 四页 + 四则键盘 + 报表 + 预算 + 导入导出 | `web/` | ✅ 已完成 |
| **M3** | 壳 APK：WebView + assets 拦截 + 签名打包 | `android/dist/*.apk` | ✅ 已完成（`mintlite-20261104-2217.apk` v1.1.0） |
| **M4** | 真机跑一周，修手感问题（键盘误触、分类顺序、报表口径） | 反馈清单 | 你来做 |
| v1.1 | 资产体系、预算结转、周期记账、标签、报销、报表增强（见 `docs/CONTRACT-v1.1.md`） | `web/` + `server/` | ✅ 已完成（接口 27/27、浏览器 E2E 26/26） |
| v1.2 | 资产升一级 tab、分组折叠/隐藏、还款提醒、多账本、成员（多用户预留）、报表 9 项筛选 + 三环 + 环比 + 月度柱、手势、APK 通知桥（见 `docs/CONTRACT-v1.2.md`） | `web/` + `server/` + `android/` | ✅ 已完成（smoke 123/123、接口 30/30、服务器模式 8/8、E2E 23/23、APK v1.2.0） |
| v1.2.1 | 真机三项：账户记忆、键盘降高、滑动/返回键退出（见 README §4） | `web/` + `android/` | ✅ 已完成（E2E 11/11 ×2 尺寸、APK v1.2.1） |
| v1.2.2 | 导入导出三格式（CSV 默认 / 薄荷记账 / JSON）+ 薄荷账单互通 + 搜索补强（见 `docs/CONTRACT-v1.2.2.md`） | `web/` + `server/` | ✅ 已完成（smoke 135/135、api-mint 36/36、导入 E2E 13/13、服务器模式 11/11、APK v1.2.3） |
| v1.2.3 | 修 Service Worker 缓存同源 `/api/` 响应导致「列表/统计不刷新」 | `web/` + `server/` | ✅ 已完成（全量回归：27/27、30/30、36/36、23/23、11/11×2、13/13、11/11） |
| v1.3 | 周期记账改暂停/恢复（删除只走长按）+ 明细页预算条 + 预算等式模型（总预算 = 明细合计 + 未分配）+ 预警阈值（默认 10%）（见 `docs/CONTRACT-v1.3.md`） | `web/` + `server/` + `android/` | ✅ 已完成（smoke 162/162、api-v13 42/42、E2E 35/35、APK 1.3.0 (8)） |
| v1.3.1 | 账户表单只给「信用卡」显示额度/账单日/还款日（花呗/借呗/白条同属信用卡），服务端对非 credit 类型强制清零 | `web/` + `server/` + `android/` | ✅ 已完成（smoke 163/163、信用字段 E2E 21/21、APK 1.3.1 (9)） |
| v1.3.2 | 预算功能总开关（`ledgers.budget_enabled`，默认关闭；关闭时明细页不渲染预算条，预算页只留「开启预算」卡；结转开关挪出标题行） | `web/` + `server/` + `android/` | ✅ 已完成（smoke 169/169、api-v13 43/43、预算开关 E2E 22/22、APK 1.3.2 (10)） |
| v1.4 | 账单极速导入（支付宝/微信 CSV 映射）、截图 OCR、报表导出图片、资产走势历史快照 | | 待做 |
| v2 | 多用户登录 + 联网同步、PIN/指纹锁、自动记账（短信→通知→OCR）、桌面小组件、投资记账 | | 待做 |


---

## 五、团队分工（本期实际执行）

| 角色 | 负责 | 写入范围 |
|---|---|---|
| Lead | 契约、计划、集成验收、APK 兜底 | `docs/`、根 `README.md` |
| backend-api | Node 服务、SQLite、鉴权、统计 SQL、冒烟测试 | `server/` |
| web-pwa | PWA 四页、四则键盘、IndexedDB、报表、同步设置 | `web/` |
| android-shell | JDK/SDK 工具链、WebView 壳、无 Gradle 打包签名 | `android/` |

验收口径：`node test/smoke.mjs` 全 PASS + `apksigner verify` 通过 + 手机能装上并记一笔。

---

## 六、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 金额浮点误差 | 报表永远差几分钱 | 整数分（已定死） |
| WebView 存储被系统清理 | 数据丢 | 每日自动导出 JSON + 服务端备份 |
| keystore 丢失 | 无法覆盖升级 | 备份到网盘；README 注明 |
| 局域网 IP 变化 | 同步连不上 | 设置页可改 baseUrl；路由器固定 DHCP |
| 自动记账正则误判 | 脏数据 | 全部进「待确认」列表，人工一键确认，不直接入账 |
| 越权（自建服务常见） | 别人能读你的账 | 每个接口校验 `ledger.user_id`（已实现） |

---

## 七、WebDev 预留说明

- 后端是纯 REST + JSON，**任何前端都能接**（以后想写 Next.js 后台管理页、Telegram Bot 记账、iOS 快捷指令，都是同一套接口）。
- `web/` 本身就是响应式网页，手机浏览器直接可用，不需要装 APK —— 这就是 Web 端的第一版。
- 服务端已开 CORS，跨域调 `/api/v1/*` 无需额外配置。
- 数据导出 JSON 是通用格式，换任何记账软件都能再导入。

---

## 八、一句话总结

**先用 WebView 壳今天装上手机能记账，数据模型和 API 一次设计到位；等手感稳定了，再决定是补原生壳（自动记账）还是换 Flutter。**
