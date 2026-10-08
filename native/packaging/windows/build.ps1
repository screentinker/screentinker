# Build the ScreenTinker native player installer for Windows.
#
#   powershell -ExecutionPolicy Bypass -File native\packaging\windows\build.ps1 [-Version 2.3.0]
#
# Output: native\dist\ScreenTinker-Setup-<Version>.exe - the path the server's /download/win and
# /api/win/update/check look in (server/lib/win-cache.js). Needs: Python 3.12 x64, Inno Setup 6.
# !! Version: X.Y.Z or X.Y.Z~rcN (same rule as the Pi .deb; `~` becomes `-` in the server's compare).
# -Addon also builds the OPTIONAL audience-counting add-on (native\packaging\audience\build-addon.py,
# native\dist\screentinker-audience_<ver>_win-x64-cp312.zip) that the installer's checkbox downloads.
param([string]$Version = "", [switch]$Addon)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$native = Resolve-Path (Join-Path $here "..\..")
$repo = Resolve-Path (Join-Path $native "..")
if (-not $Version) { $Version = (Get-Content (Join-Path $repo "VERSION") -Raw).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+(~[0-9A-Za-z.]+)?$') { throw "bad version '$Version' (X.Y.Z or X.Y.Z~rcN)" }
# Inno's version resource needs digits only; the file name keeps the full string.
$numeric = ($Version -split '~')[0]

$build = Join-Path $native "build\win"
$venv = Join-Path $build "venv"
New-Item -ItemType Directory -Force $build | Out-Null
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    & py -3.12 -m venv $venv 2>$null
    if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) { & "C:\Program Files\Python312\python.exe" -m venv $venv }
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --disable-pip-version-check -q -r (Join-Path $here "requirements.txt")
if ($LASTEXITCODE) { throw "pip install failed" }
# numpy + OpenCV in the BUILD venv only: screentinker.spec analyses them to find the standard library
# the optional audience add-on needs at run time. They are not bundled.
& $py -m pip install --disable-pip-version-check -q -r (Join-Path $native "packaging\audience\requirements.txt")
if ($LASTEXITCODE) { throw "pip install (audience probe) failed" }

# Stamp the version into the bundled copy only (version.py falls back to the checkout for -dev).
$verFile = Join-Path $native "screentinker_native\version.py"
$orig = Get-Content $verFile -Raw
try {
    ($orig -replace '(?m)^_STAMPED = .*$', "_STAMPED = `"$Version`"") | Set-Content $verFile -NoNewline
    & $py -m PyInstaller --noconfirm --clean --distpath (Join-Path $build "dist") --workpath (Join-Path $build "work") (Join-Path $here "screentinker.spec")
    if ($LASTEXITCODE) { throw "PyInstaller failed" }
} finally {
    $orig | Set-Content $verFile -NoNewline
}

# Third-party notices: ScreenTinker's MIT licence, then every bundled Python distribution's name,
# version and declared licence, then the LGPL statement Qt/PySide6 require. LGPL-3.0 is satisfied by
# dynamic linking (Qt and PySide6 ship as separate DLLs/.pyd a user can replace) plus this notice.
$notices = Join-Path $here "THIRD-PARTY-NOTICES.txt"
$lines = @("ScreenTinker Player $Version", "", (Get-Content (Join-Path $repo "LICENSE") -Raw), "",
           ("=" * 78), "Bundled third-party components", ("=" * 78), "")
$lines += & $py -c @"
import importlib.metadata as m
for d in sorted(m.distributions(), key=lambda d: (d.metadata['Name'] or '').lower()):
    n = d.metadata['Name']
    # numpy/opencv: in the build venv for the add-on probe only, not bundled (their notices ship in the add-on).
    if not n or n.lower() in ('pip', 'setuptools', 'pyinstaller', 'pyinstaller-hooks-contrib', 'altgraph', 'pefile', 'packaging',
                              'numpy', 'opencv-python-headless'):
        continue
    lic = d.metadata.get('License-Expression') or d.metadata.get('License') or ''
    if not lic or len(lic) > 80:
        cls = [c.split('::')[-1].strip() for c in (d.metadata.get_all('Classifier') or []) if c.startswith('License ::')]
        lic = ', '.join(cls) or (lic[:80] + '...' if lic else 'see package')
    print(f'{n} {d.version} - {lic}')
"@
$lines += @("", "Qt 6 and Qt for Python (PySide6, shiboken6) are licensed under the GNU Lesser General",
            "Public License v3 (LGPL-3.0). They are dynamically linked and may be replaced with a",
            "compatible build. Source: https://code.qt.io - https://www.qt.io/licensing/",
            "FFmpeg (bundled by Qt Multimedia) is licensed under the LGPL-2.1-or-later.")
$lines | Set-Content $notices -Encoding UTF8

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | ? { Test-Path $_ } | Select -First 1
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found" }
& $iscc "/DAppVersion=$Version" (Join-Path $here "ScreenTinker.iss")
if ($LASTEXITCODE) { throw "ISCC failed" }
Write-Host (Join-Path $native "dist\ScreenTinker-Setup-$Version.exe")

if ($Addon) {
    # The add-on is tied to the bundle's Python (3.12 here): its platform name says so.
    & $py (Join-Path $native "packaging\audience\build-addon.py") --platform win-x64-cp312
    if ($LASTEXITCODE) { throw "audience add-on build failed" }
}
