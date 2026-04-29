# ============================================================
# Dark Matter IDE - Local Windows Build Script
# ============================================================
# This script builds Dark Matter IDE into a Windows installer.
# Run from the repo root: .\build_exe.ps1
#
# Flags:
#   -SkipInstall     Skip 'yarn install' (use if deps are up to date)
#   -SkipElectron    Skip Electron download (use if already downloaded)
#   -SkipCompile     Skip compile+bundle step (use if source unchanged)
#   -SkipInstaller   Skip InnoSetup compression (use for fast local testing)
#   -InstallerOnly   Run ONLY the InnoSetup packaging step
# ============================================================

param(
    [switch]$SkipInstall,
    [switch]$SkipElectron,
    [switch]$SkipCompile,
    [switch]$SkipInstaller,
    [switch]$InstallerOnly
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$builtDir = "D:\OneDrive\Desktop\Projects\Dark Matter\built"
$electronCacheDir = Join-Path $root ".build\electron"

# ── Helper ───────────────────────────────────────────────────
function Step($num, $msg) { Write-Host "`n[Step $num] $msg" -ForegroundColor Cyan }
function OK($msg)         { Write-Host "  [OK] $msg" -ForegroundColor Green }
function WARN($msg)       { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function FAIL($msg)       { Write-Host "  [FAIL] $msg" -ForegroundColor Red; exit 1 }

# ── Step 1: Install dependencies ─────────────────────────────
if (-not $SkipInstall -and -not $InstallerOnly) {
    Step 1 "Installing dependencies (npm ci)..."
    npm ci
    if ($LASTEXITCODE -ne 0) { FAIL "npm ci failed" }
    OK "Dependencies installed"
} else {
    WARN "Skipping npm ci"
}

# ── Step 2: Download Electron (cached) ───────────────────────
if (-not $SkipElectron -and -not $InstallerOnly) {
    # Check if Electron is already downloaded for the right version
    $electronVersionFile = Join-Path $electronCacheDir "version"

    $needsDownload = $true
    if (Test-Path $electronVersionFile) {
        $cachedVersion = (Get-Content $electronVersionFile -Raw).Trim()
        $pkgElectron = node -e "const p=require('./package.json'); const v=p.devDependencies&&p.devDependencies.electron||p.dependencies&&p.dependencies.electron||''; console.log(v.replace(/[\^~]/,''))" 2>$null
        if ($cachedVersion -eq $pkgElectron.Trim()) {
            OK "Electron already downloaded (v$cachedVersion). Skipping download."
            $needsDownload = $false
        }
    }

    if ($needsDownload) {
        Step 2 "Downloading Electron (cached after first run)..."
        npm run electron
        if ($LASTEXITCODE -ne 0) { FAIL "Electron download failed" }
        OK "Electron downloaded"
    }
} else {
    WARN "Skipping Electron download"
}

# ── Step 3: Compile and Bundle ────────────────────────────────
if (-not $SkipCompile -and -not $InstallerOnly) {
    Step 3 "Compiling and bundling the application (10-20 minutes)..."
    $env:NODE_OPTIONS = "--max-old-space-size=8192"

    # vscode-win32-x64 = full build: compile TypeScript + bundle + package into VSCode-win32-x64\
    # Do NOT use vscode-win32-x64-min-ci (that is a CI packaging-only task, requires pre-built out-vscode-min)
    npm run gulp -- vscode-win32-x64
    if ($LASTEXITCODE -ne 0) { FAIL "Compilation and packaging failed" }
    OK "Compilation and packaging complete"
} else {
    WARN "Skipping compile step"
}

if ($SkipInstaller) {
    WARN "Skipping installer build. You can run the IDE directly from:"
    Write-Host "  D:\OneDrive\Desktop\Projects\Dark Matter\VSCode-win32-x64\Dark Matter.exe" -ForegroundColor White
    exit 0
}

# -- Step 4: Build inno-updater (creates the tools\ directory) ---------------
Step 4 "Building inno-updater (required tools directory)..."
npm run gulp -- vscode-win32-x64-inno-updater
if ($LASTEXITCODE -ne 0) { FAIL "vscode-win32-x64-inno-updater failed" }

$toolsDir = Join-Path (Split-Path $root -Parent) "VSCode-win32-x64\tools"
if (-not (Test-Path $toolsDir)) {
    FAIL "tools\ directory not created by inno-updater. Cannot build installer."
}
OK "Inno-updater built"

# -- Step 5: Build installer --------------------------------------------------
Step 5 "Building the InnoSetup installer (.exe)..."
npm run gulp -- vscode-win32-x64-user-setup
if ($LASTEXITCODE -ne 0) { FAIL "Installer build failed with exit code $LASTEXITCODE" }
OK "Installer built"

# ── Step 5: Copy output ───────────────────────────────────────
Step 5 "Copying installer to output directory..."
if (-not (Test-Path $builtDir)) {
    New-Item -ItemType Directory -Force -Path $builtDir | Out-Null
}

$setupDir = Join-Path $root ".build\win32-x64\user-setup"
$exeFiles = Get-ChildItem "$setupDir\*.exe" -ErrorAction SilentlyContinue
if ($null -eq $exeFiles -or $exeFiles.Count -eq 0) {
    FAIL "No .exe installer found in $setupDir"
}

Copy-Item $exeFiles[-1].FullName -Destination $builtDir -Force
$exeName = $exeFiles[-1].Name
OK "Build complete!"
Write-Host ""
Write-Host "  Installer: $builtDir\$exeName" -ForegroundColor White
Write-Host ""
Write-Host "  Tip - skip unchanged stages next time:" -ForegroundColor DarkGray
Write-Host "    .\build_exe.ps1 -SkipInstall" -ForegroundColor DarkGray
Write-Host "    .\build_exe.ps1 -SkipInstall -SkipElectron" -ForegroundColor DarkGray
Write-Host "    .\build_exe.ps1 -InstallerOnly" -ForegroundColor DarkGray
