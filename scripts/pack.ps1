# pack.ps1 — assemble an installable bundle of this plugin into DSH.
#
# Keeps this repository as the SINGLE SOURCE OF TRUTH for development while the
# packaged/installed copy (that DSH links in) lives in ~/.dsh/plugins/. Run
# from anywhere:
#
#   powershell -ExecutionPolicy Bypass -File scripts\pack.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\pack.ps1 -Version 0.5.0
#
# Safe by construction: .chrome-profile/ and usage.db are excluded, so no live
# credentials or usage data ever land in the packaged copy.

param(
  [string]$Version
)
$ErrorActionPreference = "Stop"

# repo root = parent of scripts/
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$pkg  = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$ver  = if ($Version) { $Version } else { [string]$pkg.version }
$homeDsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$dest = Join-Path (Join-Path $homeDsh "plugins") ($pkg.name + "-" + $ver)

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory $dest -Force | Out-Null

robocopy $repo $dest /E `
  /XD .git .chrome-profile scripts `
  /XF usage.db *.log *.tgz *.zip .gitignore .npmignore package-lock.json pnpm-lock.yaml `
  | Out-Null

Write-Host "packed $($pkg.name)@$ver -> $dest"
Write-Host "next:"
Write-Host "  1)  (re)link the profile:  New-Item -ItemType Junction '`$ENV:USERPROFILE\.dsh\profiles\desktop\node_modules\$($pkg.name)' -Target '$dest'"
Write-Host "  2)  ensure package.json dep  `"$($pkg.name)`": `"link:$dest`"  (and dsh.profile.bundles row)"
Write-Host "  3)  restart DSH Desktop"
