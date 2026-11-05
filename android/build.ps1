#Requires -Version 5.1
<#
.SYNOPSIS
    MintLite (com.mintlite.app) one-shot APK builder - no Gradle, no Android Studio.

.DESCRIPTION
    Pipeline:
        web/  --sync-->  build-assets/assets/www
        res/  --aapt2 compile/link-->  build/base.apk (resources.arsc + res/ + assets/)
        src/  --javac-->  build/classes --d8--> build/dex/classes.dex
        base.apk + classes.dex --inject--> build/unsigned.apk
        --zipalign-->  build/aligned.apk  --apksigner-->  dist/mintlite-<ts>.apk

.PARAMETER SkipToolchain
    Do not touch .toolchain/ (no download, no sdkmanager). Fails fast if a required
    binary is missing. Use on a machine where the SDK is already unpacked in place.

.PARAMETER SkipWebSync
    Reuse the existing build-assets/assets/www instead of re-copying web/.

.PARAMETER DebugKeystore
    Sign with the throwaway debug key generated on first build (default behaviour).
    Present so the flag is explicit; release signing uses keystore/mintlite.jks.

.PARAMETER WebRoot
    Source directory to package into assets/www. Defaults to <project>/web. Point it at any
    folder to test the pipeline without touching web/ (e.g. a folder with no index.html
    exercises the placeholder branch).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File android\build.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File android\build.ps1 -SkipToolchain -SkipWebSync

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File android\build.ps1 -WebRoot android\build-assets\empty-web
#>
[CmdletBinding()]
param(
    [switch]$SkipToolchain,
    [switch]$SkipWebSync,
    [switch]$DebugKeystore,
    [string]$WebRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PYTHONIOENCODING = 'utf-8'

# Everything below is UTF-8; Windows PowerShell 5.1 needs this for the Chinese log lines.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# --------------------------------------------------------------------------- paths
$Root        = $PSScriptRoot
$ProjectRoot = Split-Path $Root -Parent
$AppDir      = Join-Path $Root 'app'
$ResDir      = Join-Path $AppDir 'res'
$SrcDir      = Join-Path $AppDir 'src'
$Manifest    = Join-Path $AppDir 'AndroidManifest.xml'
$Toolchain   = Join-Path $Root '.toolchain'
$DlDir       = Join-Path $Toolchain 'dl'
$JdkHome     = Join-Path $Toolchain 'jdk'
$SdkRoot     = Join-Path $Toolchain 'sdk'
$BuildDir    = Join-Path $Root 'build'
$CompiledRes = Join-Path $BuildDir 'res-compiled'
$GenDir      = Join-Path $BuildDir 'gen'
$ClassesDir  = Join-Path $BuildDir 'classes'
$DexDir      = Join-Path $BuildDir 'dex'
$AssetsRoot  = Join-Path $Root 'build-assets'
$AssetsDir   = Join-Path $AssetsRoot 'assets'
$WwwDir      = Join-Path $AssetsDir 'www'
if (-not $WebRoot) {
    $WebRoot = Join-Path $ProjectRoot 'web'
} elseif (-not [System.IO.Path]::IsPathRooted($WebRoot)) {
    $WebRoot = Join-Path $ProjectRoot $WebRoot
}
$DistDir     = Join-Path $Root 'dist'
$KeystoreDir = Join-Path $Root 'keystore'
$Keystore    = Join-Path $KeystoreDir 'mintlite.jks'
$InjectPy    = Join-Path $Root 'tools\inject_dex.py'

$BuildToolsVersion = '34.0.0'
$PlatformDir       = Join-Path $SdkRoot 'platforms\android-34'
$BuildToolsDir     = Join-Path $SdkRoot ('build-tools\' + $BuildToolsVersion)
$AndroidJar        = Join-Path $PlatformDir 'android.jar'
$SdkManager        = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'

$PackageName = 'com.mintlite.app'
# 版本号唯一来源是 AndroidManifest.xml，避免脚本里的硬编码和 manifest 漂移。
$ManifestXml = Join-Path $Root 'app\AndroidManifest.xml'
$manifestText = Get-Content -LiteralPath $ManifestXml -Raw -Encoding utf8
if ($manifestText -match 'android:versionName="([^"]+)"') { $VersionName = $Matches[1] } else { $VersionName = '0.0.0' }
if ($manifestText -match 'android:versionCode="(\d+)"') { $VersionCode = [int]$Matches[1] } else { $VersionCode = 0 }
$KsAlias     = 'mintlite'
$KsPass      = 'mintlite123'

$Stamp    = Get-Date -Format 'yyyyMMdd-HHmm'
$FinalApk = Join-Path $DistDir ('mintlite-' + $Stamp + '.apk')

# ------------------------------------------------------------------------ helpers
function Write-Step($msg) {
    Write-Host ''
    Write-Host ('==> ' + $msg) -ForegroundColor Cyan
}

function Write-Info($msg) { Write-Host ('    ' + $msg) -ForegroundColor Gray }
function Write-Warn2($msg) { Write-Host ('  ! ' + $msg) -ForegroundColor Yellow }
function Write-Ok($msg) { Write-Host ('  + ' + $msg) -ForegroundColor Green }

function Fail($msg) {
    Write-Host ''
    Write-Host ('BUILD FAILED: ' + $msg) -ForegroundColor Red
    exit 1
}

function Assert-Path($path, $label) {
    if (-not (Test-Path -LiteralPath $path)) {
        Fail ("missing " + $label + ": " + $path)
    }
}

function New-CleanDir($path) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    New-Item -ItemType Directory -Path $path -Force | Out-Null
}

# Writes text as UTF-8 without BOM (Set-Content -Encoding utf8 on 5.1 adds a BOM).
function Write-Utf8NoBom($path, $text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Resolve-Python {
    $candidates = @()
    if ($env:MINTLITE_PYTHON) { $candidates += $env:MINTLITE_PYTHON }
    $candidates += 'C:\Users\IPO\AppData\Local\Programs\Python\Python313\python.exe'
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $cmd = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Expand-Zip($zip, $dest) {
    New-CleanDir $dest
    $py = Resolve-Python
    if ($py) {
        & $py -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" $zip $dest
        if ($LASTEXITCODE -ne 0) { Fail ("unzip failed: " + $zip) }
    } else {
        Write-Warn2 'python not found, falling back to Expand-Archive (slower)'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
    }
}

function Invoke-Native($exe, [string[]]$argv, $workdir) {
    $prev = Get-Location
    if ($workdir) { Set-Location -LiteralPath $workdir }
    try {
        & $exe @argv
        $code = $LASTEXITCODE
    } finally {
        Set-Location -LiteralPath $prev
    }
    if ($code -ne 0) {
        Fail ("command failed (exit " + $code + "): " + $exe + ' ' + ($argv -join ' '))
    }
}

function Invoke-Python($argv) {
    $py = Resolve-Python
    if (-not $py) { Fail 'python.exe not found; needed to inject classes.dex into the APK' }
    & $py @argv
    if ($LASTEXITCODE -ne 0) { Fail ('python failed (exit ' + $LASTEXITCODE + '): ' + ($argv -join ' ')) }
}

# ------------------------------------------------------------------------- banner
Write-Host ''
Write-Host 'MintLite / 薄荷轻记 - APK build (no Gradle)' -ForegroundColor White
Write-Info ('project : ' + $ProjectRoot)
Write-Info ('output  : ' + $FinalApk)

if (-not (Test-Path -LiteralPath $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }

# =============================================================== 1. toolchain prep
Write-Step '1/7 toolchain'

$required = @(
    @{ path = (Join-Path $JdkHome 'bin\javac.exe');     name = 'JDK 17 (javac)' },
    @{ path = (Join-Path $JdkHome 'bin\java.exe');      name = 'JDK 17 (java)' },
    @{ path = (Join-Path $JdkHome 'bin\keytool.exe');   name = 'JDK 17 (keytool)' },
    @{ path = (Join-Path $BuildToolsDir 'aapt2.exe');   name = 'build-tools aapt2' },
    @{ path = (Join-Path $BuildToolsDir 'd8.bat');      name = 'build-tools d8' },
    @{ path = (Join-Path $BuildToolsDir 'zipalign.exe');name = 'build-tools zipalign' },
    @{ path = (Join-Path $BuildToolsDir 'apksigner.bat'); name = 'build-tools apksigner' },
    @{ path = $AndroidJar;                              name = 'platforms;android-34' }
)

function Get-MissingTools {
    $missing = @()
    foreach ($r in $required) {
        if (-not (Test-Path -LiteralPath $r.path)) { $missing += $r }
    }
    return $missing
}

$missing = Get-MissingTools

if ($missing.Count -gt 0) {
    if ($SkipToolchain) {
        Fail ('toolchain incomplete and -SkipToolchain was given. Missing: ' + (($missing | ForEach-Object { $_.name }) -join ', '))
    }
    Write-Warn2 ('missing: ' + (($missing | ForEach-Object { $_.name }) -join ', '))

    # --- JDK 17 -------------------------------------------------------------
    if (-not (Test-Path -LiteralPath (Join-Path $JdkHome 'bin\javac.exe'))) {
        $jdkZip = Join-Path $DlDir 'jdk17.zip'
        if (-not (Test-Path -LiteralPath $jdkZip) -or (Get-Item -LiteralPath $jdkZip).Length -lt 50000000) {
            Fail ('JDK zip not available at ' + $jdkZip + ' - run the download step first (see android/README.md)')
        }
        Write-Info 'unpacking JDK 17'
        $tmp = Join-Path $Toolchain '_unpack_jdk'
        Expand-Zip $jdkZip $tmp
        $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
        if (-not $inner) { Fail 'unexpected JDK zip layout (no top-level folder)' }
        if (Test-Path -LiteralPath $JdkHome) { Remove-Item -LiteralPath $JdkHome -Recurse -Force }
        Move-Item -LiteralPath $inner.FullName -Destination $JdkHome
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok 'JDK 17 unpacked'
    }

    # everything spawned below must see this JDK, nothing global is touched
    $env:JAVA_HOME = $JdkHome
    $env:PATH = (Join-Path $JdkHome 'bin') + ';' + $env:PATH

    # --- cmdline-tools + sdk packages --------------------------------------
    if (-not (Test-Path -LiteralPath $AndroidJar)) {
        $cmdZip = Join-Path $DlDir 'cmdline-tools.zip'
        if (-not (Test-Path -LiteralPath $SdkManager)) {
            if (-not (Test-Path -LiteralPath $cmdZip)) {
                Fail ('commandlinetools zip not available at ' + $cmdZip)
            }
            Write-Info 'unpacking cmdline-tools'
            $tmp = Join-Path $Toolchain '_unpack_cmdline'
            Expand-Zip $cmdZip $tmp
            $inner = Join-Path $tmp 'cmdline-tools'
            if (-not (Test-Path -LiteralPath $inner)) { Fail 'unexpected commandlinetools zip layout' }
            $latest = Join-Path $SdkRoot 'cmdline-tools\latest'
            if (Test-Path -LiteralPath $latest) { Remove-Item -LiteralPath $latest -Recurse -Force }
            New-Item -ItemType Directory -Path (Split-Path $latest -Parent) -Force | Out-Null
            Move-Item -LiteralPath $inner -Destination $latest
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Write-Ok 'cmdline-tools -> cmdline-tools/latest'
        }

        # sdkmanager needs a writable SDK root and a JDK; it reads "y" answers from stdin
        Write-Info 'sdkmanager --licenses'
        $answers = @(); 1..40 | ForEach-Object { $answers += 'y' }
        $answers | & $SdkManager ("--sdk_root=" + $SdkRoot) '--licenses' 2>&1 | Out-Null

        Write-Info 'sdkmanager platform-tools / platforms;android-34 / build-tools;34.0.0'
        $pkgLog = Join-Path $BuildDir 'sdkmanager.log'
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
        $answers | & $SdkManager ("--sdk_root=" + $SdkRoot) 'platform-tools' 'platforms;android-34' ('build-tools;' + $BuildToolsVersion) 2>&1 |
            Tee-Object -FilePath $pkgLog | Out-Null
        if (-not (Test-Path -LiteralPath $AndroidJar)) {
            Write-Host (Get-Content -LiteralPath $pkgLog -Encoding utf8 -Tail 30 | Out-String)
            Fail 'sdkmanager did not install platforms;android-34 (see build/sdkmanager.log)'
        }
        Write-Ok 'SDK packages installed'
    }
    $env:JAVA_HOME = $JdkHome
    $env:PATH = (Join-Path $JdkHome 'bin') + ';' + $env:PATH

    $missing = Get-MissingTools
    if ($missing.Count -gt 0) {
        Fail ('still missing: ' + (($missing | ForEach-Object { $_.name }) -join ', '))
    }
}

$env:JAVA_HOME = $JdkHome
$env:PATH = (Join-Path $JdkHome 'bin') + ';' + $env:PATH
$JavaExe  = Join-Path $JdkHome 'bin\java.exe'
$JavacExe = Join-Path $JdkHome 'bin\javac.exe'
$KeyTool  = Join-Path $JdkHome 'bin\keytool.exe'
$Aapt2    = Join-Path $BuildToolsDir 'aapt2.exe'
$D8       = Join-Path $BuildToolsDir 'd8.bat'
$ZipAlign = Join-Path $BuildToolsDir 'zipalign.exe'
$ApkSign  = Join-Path $BuildToolsDir 'apksigner.bat'

$javaVersion = (& $JavacExe -version 2>&1 | Out-String).Trim()
Write-Ok ('javac: ' + $javaVersion)
Write-Ok ('sdk  : ' + $SdkRoot)

# ================================================================== 2. sync assets
Write-Step '2/7 sync web -> assets/www'

if ($SkipWebSync -and (Test-Path -LiteralPath $WwwDir)) {
    Write-Info 'skipped (-SkipWebSync)'
} else {
    if (Test-Path -LiteralPath $WwwDir) { Remove-Item -LiteralPath $WwwDir -Recurse -Force }
    New-Item -ItemType Directory -Path $WwwDir -Force | Out-Null

    $webHasIndex = (Test-Path -LiteralPath (Join-Path $WebRoot 'index.html'))
    if (Test-Path -LiteralPath $WebRoot) {
        $robocopy = Join-Path $env:SystemRoot 'System32\Robocopy.exe'
        if (Test-Path -LiteralPath $robocopy) {
            $rcArgs = @($WebRoot, $WwwDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
                        '/XD', 'node_modules', '.git', '.tmp', 'dist', '__pycache__',
                        '/XF', '*.log', '*.map.tmp')
            & $robocopy @rcArgs | Out-Null
            $rc = $LASTEXITCODE
            if ($rc -ge 8) { Fail ('robocopy failed with exit ' + $rc) }
            Write-Info ('robocopy exit ' + $rc)
        } else {
            Copy-Item -Path (Join-Path $WebRoot '*') -Destination $WwwDir -Recurse -Force
        }
    } else {
        Write-Warn2 ('web/ not found at ' + $WebRoot)
    }

    if (-not (Test-Path -LiteralPath (Join-Path $WwwDir 'index.html'))) {
        Write-Warn2 ('no index.html under ' + $WebRoot + ' -> writing a throwaway placeholder (build-assets only, web/ untouched)')
        Write-Utf8NoBom (Join-Path $WwwDir 'index.html') @'
<!doctype html><meta charset="utf-8"><h1>MintLite</h1>
'@
    }

    $fileCount = (Get-ChildItem -LiteralPath $WwwDir -Recurse -File | Measure-Object).Count
    $bytes = (Get-ChildItem -LiteralPath $WwwDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { $bytes = 0 }
    Write-Ok ('assets/www: ' + $fileCount + ' files, ' + [math]::Round($bytes / 1KB, 1) + ' KB')
}

# ============================================================== 3. resources/aapt2
Write-Step '3/7 aapt2 compile + link'

New-CleanDir $CompiledRes
New-CleanDir $GenDir
New-CleanDir $ClassesDir
New-CleanDir $DexDir

Invoke-Native $Aapt2 @('compile', '--dir', $ResDir, '-o', $CompiledRes) $null
$flats = @(Get-ChildItem -LiteralPath $CompiledRes -Recurse -File -Filter '*.flat' | ForEach-Object { $_.FullName })
if ($flats.Count -eq 0) { Fail 'aapt2 compile produced no .flat files' }
Write-Info ('compiled resources: ' + $flats.Count)

$BaseApk = Join-Path $BuildDir 'base.apk'
if (Test-Path -LiteralPath $BaseApk) { Remove-Item -LiteralPath $BaseApk -Force }

# versionCode / versionName live in the manifest; aapt2 does not need to be told again.
$linkArgs = @(
    'link',
    '-o', $BaseApk,
    '-I', $AndroidJar,
    '--manifest', $Manifest,
    '-A', $AssetsDir,
    '--java', $GenDir,
    '--auto-add-overlay'
) + $flats
Invoke-Native $Aapt2 $linkArgs $null
Write-Ok ('base.apk ' + [math]::Round((Get-Item -LiteralPath $BaseApk).Length / 1KB, 1) + ' KB')

$RJava = Join-Path $GenDir ($PackageName -replace '\.', '\')
$RJavaFile = Join-Path $RJava 'R.java'
Assert-Path $RJavaFile 'generated R.java'

# ================================================================= 4. javac + d8
Write-Step '4/7 javac + d8'

$javaSources = @(Get-ChildItem -LiteralPath $SrcDir -Recurse -File -Filter '*.java' | ForEach-Object { $_.FullName })
if ($javaSources.Count -eq 0) { Fail ('no .java under ' + $SrcDir) }
$javaSources += $RJavaFile

# -J-Duser.language=en keeps javac's own diagnostics in English: its localized output is
# written in the OEM code page and turns into mojibake inside a UTF-8 PowerShell console.
$javacArgs = @(
    '-J-Duser.language=en', '-J-Duser.country=US',
    '-encoding', 'UTF-8',
    '-source', '8', '-target', '8',
    '-bootclasspath', $AndroidJar,
    '-classpath', $AndroidJar,
    '-Xlint:-options',
    '-d', $ClassesDir
) + $javaSources
Invoke-Native $JavacExe $javacArgs $null
$classCount = @(Get-ChildItem -LiteralPath $ClassesDir -Recurse -File -Filter '*.class').Count
Write-Info ('javac classes: ' + $classCount)

$classFiles = @(Get-ChildItem -LiteralPath $ClassesDir -Recurse -File -Filter '*.class' | ForEach-Object { $_.FullName })
$d8Args = @('--lib', $AndroidJar, '--min-api', '24', '--output', $DexDir) + $classFiles
Invoke-Native $D8 $d8Args $null
$DexFile = Join-Path $DexDir 'classes.dex'
Assert-Path $DexFile 'classes.dex'
Write-Ok ('classes.dex ' + [math]::Round((Get-Item -LiteralPath $DexFile).Length / 1KB, 1) + ' KB')

# ============================================================== 5. package + sign
Write-Step '5/7 package, zipalign, sign'

$UnsignedApk = Join-Path $BuildDir 'unsigned.apk'
$AlignedApk  = Join-Path $BuildDir 'aligned.apk'
if (Test-Path -LiteralPath $UnsignedApk) { Remove-Item -LiteralPath $UnsignedApk -Force }
if (Test-Path -LiteralPath $AlignedApk) { Remove-Item -LiteralPath $AlignedApk -Force }

Invoke-Python @($InjectPy, $BaseApk, $DexFile, $UnsignedApk)
Write-Ok 'classes.dex injected'

Invoke-Native $ZipAlign @('-f', '-p', '4', $UnsignedApk, $AlignedApk) $null
Write-Ok 'zipalign 4'

if (-not (Test-Path -LiteralPath $Keystore)) {
    New-Item -ItemType Directory -Path $KeystoreDir -Force | Out-Null
    Write-Info 'generating self-signed debug keystore'
    $dname = 'CN=MintLite, OU=Personal, O=MintLite, L=Local, C=CN'
    # keytool's own -J pass-through does not survive PowerShell's native-argument quoting,
    # so the JVM options go through JAVA_TOOL_OPTIONS instead (also keeps the log English).
    $prevToolOpts = $env:JAVA_TOOL_OPTIONS
    $env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'
    try {
        Invoke-Native $KeyTool @(
            '-genkeypair',
            '-keystore', $Keystore,
            '-storetype', 'JKS',
            '-alias', $KsAlias,
            '-keyalg', 'RSA',
            '-keysize', '2048',
            '-validity', '10000',
            '-storepass', $KsPass,
            '-keypass', $KsPass,
            '-dname', $dname
        ) $null
    } finally {
        $env:JAVA_TOOL_OPTIONS = $prevToolOpts
    }
    Write-Ok 'keystore created'
}

if (Test-Path -LiteralPath $FinalApk) { Remove-Item -LiteralPath $FinalApk -Force }
Invoke-Native $ApkSign @(
    'sign',
    '--ks', $Keystore,
    ('--ks-pass=pass:' + $KsPass),
    ('--key-pass=pass:' + $KsPass),
    ('--ks-key-alias=' + $KsAlias),
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v4-signing-enabled', 'false',
    '--out', $FinalApk,
    $AlignedApk
) $null
Write-Ok 'apksigner sign'

# ================================================================== 6. verify apk
Write-Step '6/7 verify'

$verifyOut = (& $ApkSign @('verify', '--print-certs', '--verbose', $FinalApk) 2>&1 | Out-String)
$verifyCode = $LASTEXITCODE
Write-Host $verifyOut.TrimEnd()
if ($verifyCode -ne 0) { Fail ('apksigner verify failed (exit ' + $verifyCode + ')') }

$badging = (& $Aapt2 @('dump', 'badging', $FinalApk) 2>&1 | Out-String)
$pkgLine = ($badging -split "`n" | Where-Object { $_ -match '^package:' } | Select-Object -First 1)
$labelLine = ($badging -split "`n" | Where-Object { $_ -match 'application-label' } | Select-Object -First 1)
Write-Host ('    ' + $pkgLine.TrimEnd())
Write-Host ('    ' + $labelLine.TrimEnd())

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($FinalApk)
try {
    $entryNames = @($zip.Entries | ForEach-Object { $_.FullName })
} finally {
    $zip.Dispose()
}
foreach ($need in @('classes.dex', 'resources.arsc', 'AndroidManifest.xml', 'assets/www/index.html')) {
    if ($entryNames -notcontains $need) { Fail ('APK is missing ' + $need) }
}
$assetCount = @($entryNames | Where-Object { $_ -like 'assets/www/*' }).Count
Write-Host ('    entries: classes.dex | resources.arsc | AndroidManifest.xml | assets/www/index.html | assets/www/* x' + $assetCount)
$apkSize = (Get-Item -LiteralPath $FinalApk).Length
$sha256 = (Get-FileHash -LiteralPath $FinalApk -Algorithm SHA256).Hash

Write-Step '7/7 done'
Write-Host ''
Write-Host ('APK    : ' + $FinalApk) -ForegroundColor Green
Write-Host ('size   : ' + [math]::Round($apkSize / 1KB, 1) + ' KB (' + $apkSize + ' bytes)') -ForegroundColor Green
Write-Host ('sha256 : ' + $sha256)
Write-Host ('pkg    : ' + $PackageName + '  v' + $VersionName + ' (' + $VersionCode + ')')
Write-Host ''
Write-Host 'install: adb install -r "' -NoNewline
Write-Host ($FinalApk + '"') -NoNewline
Write-Host ''
Write-Host 'launch : adb shell am start -n ' -NoNewline
Write-Host ($PackageName + '/.MainActivity')
Write-Host ''

# 体积自检：正常的 web/ 打包后约 95~120 KB；明显偏小说明 assets 没同步进去。
# （注意：只检查 APK 体积，不要用「小于 300KB」这类阈值——整个 PWA 现在只有 200 KB 源码。）
if ($apkSize -lt 60KB -or $assetCount -lt 5) {
    Write-Warn2 ('APK 偏小（' + [math]::Round($apkSize / 1KB, 1) + ' KB / ' + $assetCount + ' 个 assets 文件）——检查 -WebRoot 指向的目录里是不是只有占位页。')
}

# robocopy reports success as exit code 1, which would otherwise leak into $LASTEXITCODE
# and make this script look like a failed build to any caller.
exit 0
