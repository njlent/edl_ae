# Install EDL AE for After Effects (Windows PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1            # panel (user folder, no admin)
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Plugin    # also EdlAE.aex (asks for admin)
#
# -AeVersion picks the After Effects version folder (default: newest installed).

param(
    [switch]$Plugin,
    [string]$AeVersion = "",
    [string]$AeDir = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$bundle = Join-Path $repo "dist\EDL_AE.jsx"
if (-not (Test-Path $bundle)) { throw "dist\EDL_AE.jsx not found. Run 'node scripts/build.mjs' first." }

# Panel: per-user Scripts folder, picked up by After Effects without admin rights.
$prefsRoot = Join-Path $env:APPDATA "Adobe\After Effects"
if (-not $AeVersion) {
    $AeVersion = Get-ChildItem $prefsRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1 -ExpandProperty Name
}
if (-not $AeVersion) { throw "No After Effects preferences folder found under $prefsRoot." }
$panelDir = Join-Path $prefsRoot "$AeVersion\Scripts\ScriptUI Panels"
New-Item -ItemType Directory -Force $panelDir | Out-Null
Copy-Item $bundle (Join-Path $panelDir "EDL_AE.jsx") -Force
Write-Host "Panel installed: $panelDir\EDL_AE.jsx"

if ($Plugin) {
    $aex = Join-Path $repo "plugin\build\Release\EdlAE.aex"
    if (-not (Test-Path $aex)) { throw "plugin\build\Release\EdlAE.aex not found. Build it first (see README)." }
    if (-not $AeDir) {
        $AeDir = Get-ChildItem "C:\Program Files\Adobe" -Directory -Filter "Adobe After Effects *" |
            Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    $dest = Join-Path $AeDir "Support Files\Plug-ins\EDL AE"
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
        New-Item -ItemType Directory -Force $dest | Out-Null
        Copy-Item $aex (Join-Path $dest "EdlAE.aex") -Force
    } else {
        $cmd = "New-Item -ItemType Directory -Force '$dest' | Out-Null; Copy-Item '$aex' '$dest\EdlAE.aex' -Force"
        Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile", "-Command", $cmd
    }
    if (Test-Path (Join-Path $dest "EdlAE.aex")) { Write-Host "Plugin installed: $dest\EdlAE.aex" }
    else { throw "Plugin copy failed (admin rights declined?)." }
}

Write-Host "Restart After Effects. Check Preferences > Scripting & Expressions > 'Allow Scripts to Write Files and Access Network'."
