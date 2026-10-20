# Build the ScreenTinker studio cache node installer for Windows 10/11 (x64).
#
#   powershell -ExecutionPolicy Bypass -File server\packaging\windows\build.ps1 [-Version 3.0.2]
#
# Output: server\packaging\windows\dist\ScreenTinker-CacheNode-Setup-<Version>.exe
# Needs: Windows x64, NSIS 3 (makensis.exe), internet access to nodejs.org, github.com and the npm
# registry. Nothing else: Node is downloaded here and bundled, so the target PC needs no Node install.
#
# What goes in:
#   node\                    Node.js $NodeVersion (official win-x64 zip, SHA-256 checked)
#   app\                     the server as the release tarball ships it, with production node_modules
#                            installed BY THIS Node on Windows (so better-sqlite3 is the win32 build)
#   ScreenTinkerCacheNode.exe/.xml   WinSW 2.12.0 (MIT), which runs node as a Windows service
param(
    [string]$Version = "",
    [string]$NodeVersion = "22.23.3",
    # From https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
    [string]$NodeSha256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
    [string]$WinSwVersion = "2.12.0",
    # SHA-256 of WinSW-x64.exe from the v2.12.0 GitHub release (that release predates GitHub's
    # published asset digests, so it was computed from the official download and pinned here).
    [string]$WinSwSha256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with the progress bar

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..\..")
if (-not $Version) { $Version = (Get-Content (Join-Path $repo "VERSION") -Raw).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+([~-][0-9A-Za-z.]+)?$') { throw "bad version '$Version'" }
$numeric = ($Version -split '[~-]')[0]

$build = Join-Path $here "build"
$cache = Join-Path $build "cache"
$stage = Join-Path $build "stage"
$dist = Join-Path $here "dist"
New-Item -ItemType Directory -Force $cache, $dist | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

function Get-Checked([string]$url, [string]$file, [string]$sha256) {
    $path = Join-Path $cache $file
    if (-not (Test-Path $path) -or (Get-FileHash $path -Algorithm SHA256).Hash -ne $sha256.ToUpper()) {
        Write-Host "==> downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
    }
    $got = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($got -ne $sha256.ToUpper()) { Remove-Item -Force $path; throw "$file checksum mismatch: got $got, expected $sha256" }
    return $path
}

# ---- Node.js ----
$nodeZip = Get-Checked "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" "node-v$NodeVersion-win-x64.zip" $NodeSha256
Write-Host "==> unpacking Node $NodeVersion"
Expand-Archive -Path $nodeZip -DestinationPath $build -Force
Move-Item (Join-Path $build "node-v$NodeVersion-win-x64") (Join-Path $stage "node")
$nodeDir = Join-Path $stage "node"
$node = Join-Path $nodeDir "node.exe"
$npm = Join-Path $nodeDir "npm.cmd"

# ---- WinSW ----
$winsw = Get-Checked "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe" "WinSW-$WinSwVersion-x64.exe" $WinSwSha256
Copy-Item $winsw (Join-Path $stage "ScreenTinkerCacheNode.exe")
Copy-Item (Join-Path $here "ScreenTinkerCacheNode.xml") (Join-Path $stage "ScreenTinkerCacheNode.xml")

# ---- the server, as the release tarball ships it ----
Write-Host "==> staging the server"
$app = Join-Path $stage "app"
New-Item -ItemType Directory -Force $app | Out-Null
function Copy-Tree([string]$name, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @()) {
    $src = Join-Path $repo $name
    $dst = Join-Path $app $name
    $rc = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($excludeDirs.Count) { $rc += "/XD"; $rc += $excludeDirs }
    if ($excludeFiles.Count) { $rc += "/XF"; $rc += $excludeFiles }
    & robocopy @rc | Out-Null
    # robocopy: 0-7 are success codes, 8+ are failures.
    if ($LASTEXITCODE -ge 8) { throw "robocopy $name failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}
# State never ships: no database, uploads, certificates (JWT secret) or plugins installed at run time.
Copy-Tree "server" @("node_modules", "test", "packaging", "uploads", "certs") @("*.db", "*.db-wal", "*.db-shm", ".jwt_secret")
Copy-Tree "frontend"
Copy-Tree "plugins"
Copy-Tree "catalog"
Copy-Tree "scripts"
Copy-Tree "docs"
foreach ($f in @("VERSION", "LICENSE", "certified-hardware.json")) { Copy-Item (Join-Path $repo $f) (Join-Path $app $f) }
Set-Content -Path (Join-Path $app "VERSION") -Value $Version -NoNewline

# The status page belongs to this package only; a stock server never serves it.
Copy-Item (Join-Path $here "status\cache-node.html") (Join-Path $app "frontend\cache-node.html")
Copy-Item (Join-Path $here "status\cache-node-status.js") (Join-Path $app "frontend\js\cache-node-status.js")

# ---- production dependencies, installed by the bundled Node so native modules match it ----
Write-Host "==> npm ci --omit=dev (bundled Node $NodeVersion)"
$env:PATH = "$nodeDir;$env:PATH"
Push-Location (Join-Path $app "server")
try {
    & $npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE) { throw "npm ci failed" }
    # better-sqlite3 is optional (node:sqlite is the fallback), but a cache node should not run on the
    # experimental driver because a prebuilt binary failed to download. npm ci skips a failed optional
    # install without a word, so retry that one package with its install output shown, then fail.
    $probe = "const D=require('better-sqlite3'); const d=new D(':memory:'); d.prepare('select 1').get(); console.log('better-sqlite3 ok')"
    & $node -e $probe
    if ($LASTEXITCODE) {
        $bsVersion = (Get-Content "package.json" -Raw | ConvertFrom-Json).optionalDependencies.'better-sqlite3'
        Write-Host "==> better-sqlite3 was skipped by npm ci; what npm logged about it:"
        $npmLog = Get-ChildItem (Join-Path $env:LOCALAPPDATA "npm-cache\_logs\*-debug-*.log") -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime | Select-Object -Last 1
        if ($npmLog) { Select-String -Path $npmLog.FullName -Pattern "better-sqlite3|node-addon-api" | Select-Object -First 40 | ForEach-Object { "    " + $_.Line } }
        Write-Host "==> installing better-sqlite3 $bsVersion on its own"
        & $npm install --no-save --omit=dev --no-audit --no-fund --foreground-scripts "better-sqlite3@$bsVersion"
        & $node -e $probe
        if ($LASTEXITCODE) { throw "better-sqlite3 did not load with the bundled Node" }
    }
} finally { Pop-Location }

# ---- installer (NSIS 3: zlib/libpng licence, free for any use) ----
$makensis = @(
    (Get-Command makensis.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
    "$env:ProgramFiles\NSIS\makensis.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $makensis) { throw "NSIS 3 (makensis.exe) not found: https://nsis.sourceforge.io" }
Write-Host "==> building the installer"
& $makensis -V2 "-DVERSION=$Version" "-DVERSION_NUMERIC=$numeric" "-DSTAGE_DIR=$stage" "-DOUTPUT_DIR=$dist" (Join-Path $here "ScreenTinkerCacheNode.nsi")
if ($LASTEXITCODE) { throw "makensis failed" }
$out = Join-Path $dist "ScreenTinker-CacheNode-Setup-$Version.exe"
Write-Host "==> $out"
Write-Host ("    SHA-256 " + (Get-FileHash $out -Algorithm SHA256).Hash.ToLower())
