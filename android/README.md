# MintLite Android 壳（无 Gradle 构建）

`com.mintlite.app` —— 一个 Activity + WebView，把 `web/` 里的离线 PWA 打进 APK 的 `assets/www/`，
用 `https://appassets.androidplatform.net/` 这个假的 https 源把资源喂给 WebView。

整条流水线只用 JDK + Android SDK 的几个命令行工具，没有 Gradle、没有 AndroidX、没有 Android Studio。

---

## 1. 目录

```
android/
├─ app/
│  ├─ AndroidManifest.xml            # 包名 / 权限 / 主题 / cleartext
│  ├─ res/
│  │  ├─ values/strings.xml          # app_name = MintLite
│  │  ├─ values/styles.xml           # AppTheme: NoActionBar + #2E7D6F 状态栏
│  │  ├─ drawable/ic_launcher.xml    # 矢量图标（薄荷绿圆 + 白色 ¥）
│  │  └─ xml/network_security_config.xml
│  └─ src/com/mintlite/app/MainActivity.java
├─ tools/inject_dex.py               # 把 classes.dex 塞进 aapt2 产出的 apk
├─ keystore/mintlite.jks             # 调试签名（仓库不含，首次构建自动生成）
├─ build-assets/assets/www/          # web/ 的构建期副本，勿手改
├─ .toolchain/                       # 便携 JDK 17 + Android SDK（约 1.5 GB）
├─ build/                            # 中间产物，可整目录删
├─ dist/mintlite-<yyyyMMdd-HHmm>.apk # 交付物
└─ build.ps1
```

## 2. 环境要求

- Windows 10/11 + PowerShell 5.1（不需要管理员权限）
- Python 3（只用来解压 zip 和注入 dex；脚本会依次找 `$env:MINTLITE_PYTHON`、
  `C:\Users\IPO\AppData\Local\Programs\Python\Python313\python.exe`、`PATH` 里的 `python`）
- 下面这些东西**全部装在 `android/.toolchain/` 里**，不写注册表、不改全局 `PATH`：

| 组件 | 落点 | 来源 |
|---|---|---|
| JDK 17 (Temurin, 免安装) | `.toolchain/jdk` | `https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse` |
| cmdline-tools | `.toolchain/sdk/cmdline-tools/latest` | `https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip` |
| platform-tools / platforms;android-34 / build-tools;34.0.0 | `.toolchain/sdk/...` | `sdkmanager` |

`build.ps1` 只在自身进程里 `$env:JAVA_HOME` / `$env:PATH`，退出即失效。

两个 zip 留在 `.toolchain/dl/`（jdk17.zip 191 MB、cmdline-tools.zip 154 MB），删了也不影响构建；
要重下就走断点续传，脚本用的就是这套（GB 级文件在本机实测断过 2 次，`-C -` 接着下）：

```powershell
cd android\.toolchain\dl
curl.exe -L -C - --connect-timeout 15 --speed-limit 2000 --speed-time 45 -o jdk17.zip `
  https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse
# adoptium 被墙时的实测备用源（内层目录名 jdk-17.0.20.1+1）
# https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip
curl.exe -L -C - --connect-timeout 15 -o cmdline-tools.zip `
  https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip
# 备用源：https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-11076708_latest.zip
```

解压后记得把内层 `cmdline-tools/` 挪成 `.toolchain/sdk/cmdline-tools/latest/`
（`sdkmanager.bat` 必须在 `.../cmdline-tools/latest/bin/` 下，SDK 才认）。

## 3. 构建

```powershell
cd D:\deepseek-harness\_sessions\2026-11-04_2014_money-tracker
powershell -ExecutionPolicy Bypass -File android\build.ps1
```

常用参数：

```powershell
# 已确认工具链齐全，跳过检查（省 2 秒，缺东西会直接报错退出）
powershell -ExecutionPolicy Bypass -File android\build.ps1 -SkipToolchain

# 只改 Java/资源、web 没动：跳过 web 同步
powershell -ExecutionPolicy Bypass -File android\build.ps1 -SkipToolchain -SkipWebSync
```

  Divider: 脚本做的事：

1. 检查 `.toolchain/`，缺 JDK 就解压 `dl/jdk17.zip`，缺 SDK 就解压 cmdline-tools 并跑
   `sdkmanager --licenses` + 装三个包；
2. `web/` → `build-assets/assets/www`（robocopy 复制 + 覆盖，排除 `node_modules`/`.git`/`.tmp`/`dist`）；
   如果 `index.html` 还不存在，会往**副本**里写一个占位页，绝不碰 `web/`；
   想拿别的目录做包可以 `-WebRoot android\build-assets\empty-web`；
3. `aapt2 compile --dir app/res` → `aapt2 link`（`-A assets` 把 www 打进去，`--java` 生成 R.java）；
4. `javac -encoding UTF-8 -source 8 -target 8 -bootclasspath android.jar` → `d8 --min-api 24`；
5. `tools/inject_dex.py` 重打包 apk（规范化 zip 头 + 加 `classes.dex`）→ `zipalign -p 4` → `apksigner sign`
   （v2 + v3，不生成 v4 的 `.idsig`）；
6. `apksigner verify --print-certs` + `aapt2 dump badging` + zip 条目检查，打印包名、大小、sha256。

产物：`android/dist/mintlite-<yyyyMMdd-HHmm>.apk`。**脚本成功时 `exit 0`**，失败时打印
`BUILD FAILED: <原因>` 并 `exit 1`。

> 包体大小取决于 `web/` 有多大：整个 PWA 只有 ~200 KB 时，deflate 之后进 APK 约 70 KB，
> 成品 ≈ 97 KB；`web/` 长到 ~310 KB 时成品 ≈ 126 KB（`assets/www` 里的每个文件都在，
> 可以用 `zipalign -c -v 4` 和 `aapt2 dump badging` 复核）。
> 前端加图标/字体以后自然变大，不用为了凑体积塞垃圾文件。

## 4. 安装

```powershell
# 有设备/模拟器时
$apk = (Get-ChildItem android\dist\*.apk | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
android\.toolchain\sdk\platform-tools\adb.exe devices
android\.toolchain\sdk\platform-tools\adb.exe install -r "$apk"
# 覆盖安装失败（签名或降级）时先卸
android\.toolchain\sdk\platform-tools\adb.exe uninstall com.mintlite.app

# 启动 + 看日志
android\.toolchain\sdk\platform-tools\adb.exe shell am start -n com.mintlite.app/.MainActivity
android\.toolchain\sdk\platform-tools\adb.exe logcat -s MintLite chromium
```

装完自检（不依赖设备）：

```powershell
$bt  = 'android\.toolchain\sdk\build-tools\34.0.0'
$apk = (Get-ChildItem android\dist\*.apk | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
& "$bt\apksigner.bat" verify --print-certs --verbose "$apk"
& "$bt\aapt2.exe" dump badging "$apk"
& "$bt\zipalign.exe" -c -v 4 "$apk"
```

WebView 调试：`chrome://inspect`（`MainActivity` 里已开 `setWebContentsDebuggingEnabled(true)`）。

## 5. 为什么是 WebView 壳

PWA 那边已经把记账的核心逻辑（四则运算键盘、IndexedDB 本地存储、报表、导入导出）写成了一套原生 JS，
再套一个 Flutter 或 Kotlin 原生壳等于把 UI 和数据层重写第二遍：两套代码要同步改、离线存储要重新设计、
包体还要多背一个 Flutter engine（~20 MB）。WebView 壳只做三件事——把静态资源塞进 APK、
给一个稳定的 https 源让 localStorage/IndexedDB 落地、处理返回键和旋转——体积不到 1 MB，
前端改完重跑一次 `build.ps1` 就出新包，和浏览器里调试的是同一份代码。
代价是首屏受 WebView 版本影响、复杂动画帧率不如原生；对一个月几千条流水的记账 App 完全够用。

用 `file://` 加载会是坑：`file://` 属于不透明源，localStorage/IndexedDB 不持久，页面一刷新数据就没了，
所以这里用 `WebViewClient.shouldInterceptRequest` 自己把 `https://appassets.androidplatform.net/*`
映射到 `assets/www/*`（`MainActivity.java` 里的 `intercept()`，含 MIME 表和 404 处理）。

## 6. 改包名 / 换签名

**改包名**（三处必须一致）：

1. `app/AndroidManifest.xml` 的 `package="com.mintlite.app"`；
2. Java 目录 `app/src/com/mintlite/app/` 整体改名，`MainActivity.java` 第一行 `package ...;` 跟着改；
3. `build.ps1` 顶部的 `$PackageName`（只用于打印 R.java 路径和安装提示）。

**换签名**：

```powershell
# 生成自己的 keystore
& android\.toolchain\jdk\bin\keytool.exe -genkeypair -keystore android\keystore\my.jks -storetype JKS `
  -alias mykey -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass <STORE_PASS> -keypass <KEY_PASS> -dname "CN=Me, O=Me, C=CN"
```

然后改 `build.ps1` 顶部四个变量：`$Keystore`、`$KsAlias`、`$KsPass`（`$KsPass` 同时用于 store 和 key）。
正式发布建议把密码从命令行挪到环境变量，`apksigner` 支持 `--ks-pass env:MINTLITE_KS_PASS`。

> `keystore/mintlite.jks` 的口令是 `mintlite123`，**只用于自己调试装机**。这个文件已被 `.gitignore` 排除，
> 仓库里不会有私钥；首次构建时 `build.ps1` 会用 `keytool` 现场生成一把。要发版或给别人装，务必按上面的
> 步骤换一把自己的 key，别把私钥提交上去。

签名变了以后手机上的旧包装不上去（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），先 `adb uninstall com.mintlite.app`。

## 7. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 白屏 | `assets/www/index.html` 没打进去；看 `adb logcat -s MintLite`，脚本也会在启动时显示错误页 |
| 数据一刷新就没 | 说明页面被当成了非安全源；确认走的是 `https://appassets.androidplatform.net/` 而不是 `file://` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 换了签名 / 改了包名，先卸载旧包 |
| `INSTALL_FAILED_VERIFICATION_FAILURE` | 手机开了"验证应用"，用 `adb install --bypass-low-target-sdk-block` 或关掉的开关 |
| 局域网 http 同步被拦 | 已开 `usesCleartextTraffic` + `network_security_config`，若仍拦，检查是不是用了 `https` 之外的自签证书 |
| `sdkmanager` 卡住 | 加 `--verbose` 手动跑一遍；license 提示要输入 `y`，脚本是管道灌 `y` 的 |
| `corrupt zip entry: assets/www/*.js` | aapt2 在 Windows 上把 **本地文件头**里的路径写成反斜杠（`assets/www\app.js`），中央目录里却是正斜杠。Android 只读中央目录所以不影响装机，但 `python -m zipfile -t`、`unzip` 会报损坏。`tools/inject_dex.py` 因此不追加而是整包重写，把两边的名字统一成正斜杠 |
| 构建日志里中文变成 `钖勮嵎杞昏` / `ע:` | `build.ps1` 是 **UTF-8 with BOM**，别用会去掉 BOM 的编辑器保存：PowerShell 5.1 对无 BOM 的脚本按 GBK 解码，中文字面量全乱。javac/keytool 的提示同理，已在命令行加 `-J-Duser.language=en` 输出英文 |
| `unknown option '--version-code=1'` | 这台机器的 aapt2 只认 `--version-code 1` 这种空格写法；版本号本来就写在 manifest 里，脚本已不再传该参数 |
| `apksigner verify` 说 `v1 scheme: false` | 正常：`minSdk 24` 以上只要 v2/v3，v1 不会生成。真要 v1 就把 minSdk 降到 23 以下 |

## 8. 通知桥与导航策略（v1.2）

`MainActivity` 在 `loadUrl` 之前注册了 `addJavascriptInterface(new Bridge(), "MintLiteBridge")`，
前端拿到的 API：

| JS 调用 | 行为 |
|---|---|
| `MintLiteBridge.platform()` | 返回 `"android"`，前端用它判断「是不是壳里」 |
| `MintLiteBridge.notify(title, body)` | 发一条通知。channel `mintlite_reminder`（IMPORTANCE_DEFAULT，首次调用时创建）；Android 8 以下走无 channel 的 `Notification.Builder` + `PRIORITY_DEFAULT`；小图标用系统 `android.R.drawable.ic_dialog_info`，不引任何依赖；点通知回到 `MainActivity`。`body` 为空直接丢弃 |
| `MintLiteBridge.requestNotifyPermission()` | 仅 Android 13+ 需要，且**只在 JS 主动调用时**弹权限框，启动不弹 |
| `MintLiteBridge.exitApp()` | 退到后台（`moveTaskToBack(true)`），**不** `finish()`：WebView 页面与 localStorage/IndexedDB 都留着，再点图标回来还在原来那页 |

提醒的调度在 PWA 侧（契约 4.7）：`kind=liability`、`used_cents>0`、有 `repay_day`，
`days_left<=3` 时每天最多调一次 `notify()`，用 `localStorage` 去重。壳这边无闹钟、无后台服务、
无 WorkManager——进程不在就不提醒，这是有意的取舍。

**返回键 / 滑动退出（v1.2.1）**：壳不再自己 `goBack()` 或双击退出，而是先问页面——
`onBackPressed()` 执行

```js
(function(){try{return !!(window.MintLiteBack && window.MintLiteBack());}catch(e){return false;}})()
```

回调里只有返回值恰好是字符串 `"true"` 才算「页面消费掉了」（关弹层、回上一级）；其余（`"false"`、
`"null"`、页面还没加载）一律 `moveTaskToBack(true)` 退到后台。`evaluateJavascript` 是异步的，
所以判断放在 `ValueCallback` 里，不能用返回值直接判。前端那侧的契约：
`window.MintLiteBack()` 返回 `true` = 已消费，返回 `false` = 已在根页；左右滑手势同样调它（或直接
调 `exitApp()`）。壳只负责「到头了就退」，不猜前端路由。

> 注意：`javac` 在这套构建里用的是 `-bootclasspath android.jar`，`android.jar` 里没有
> `java.lang.invoke.LambdaMetafactory`，所以**不能写 lambda**（会报
> `Fatal Error: Unable to find method metafactory`）。回调一律用匿名内部类，和文件里其它代码保持一致。

**导航策略（安全相关，别随手放开）**：`shouldOverrideUrlLoading` 只让
`https://appassets.androidplatform.net` 及其子路径在 WebView 里加载；其它 `http(s)` 页面、
`mailto:`/`tel:`/`intent:` 一律 `Intent.ACTION_VIEW` 交给系统，并返回 `true`（`about:`/`data:`
留在内部）。原因是 `addJavascriptInterface` 是**整 WebView 级**的：任何第三方页面只要被加载进来，
就能调到 `MintLiteBridge`。把外部文档挡在外面，桥才只暴露给我们自己的 assets。

Android 13+ 用户拒绝通知权限后，`notify()` 只写一条 `MintLite` 日志并静默丢弃，不会崩、不会重复弹框；
要看效果就 `adb logcat -s MintLite`。
