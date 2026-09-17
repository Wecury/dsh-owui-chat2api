# pack.ps1 — assemble an installable bundle of this plugin into DSH.
#
# Keeps this repository as the SINGLE SOURCE OF TRUTH for development while the
# packaged/installed copy (that DSH links in) lives in ~/.dsh/plugins/. Run
# from anywhere:
#
#   powershell -ExecutionPolicy Bypass -File scripts\pack.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\pack.ps1 -Version 0.8.0
#
# After copying it ALSO relinks the profile automatically (junction + profile
# package.json dep), so the local test loop is exactly:
#
#   scripts\pack.ps1  ->  restart DSH Desktop
#
# Safe by construction: .chrome-profile/ and usage.db are excluded, so no live
# credentials or usage data ever land in the packaged copy. /MIR never removes
# the destination root and never touches /XD-excluded dirs, so a repack also
# works while the proxy is running (bundle/chat2api is its CWD) and never
# wipes the live .chrome-profile.

param(
  [string]$Version
)
$ErrorActionPreference = "Stop"

# Build the client half FIRST: the install copy below mirrors it, and the
# tgz at the end packs it. Doing this any later would ship a stale client.js.
node (Join-Path $PSScriptRoot "build-client.mjs")
if ($LASTEXITCODE -ne 0) { throw "client bundle build failed" }

# repo root = parent of scripts/
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$pkg  = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$ver  = if ($Version) { $Version } else { [string]$pkg.version }
$homeDsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$dest = Join-Path (Join-Path $homeDsh "plugins") ($pkg.name + "-" + $ver)

# NOTE: /MIR (mirror) instead of delete-first + /E. It never removes the
# destination root and never touches /XD-excluded dirs, so a repack also works
# while the proxy is running (bundle/chat2api is its CWD, and deleting that dir
# is refused by Windows) and never wipes the live .chrome-profile.
robocopy $repo $dest /MIR `
  /XD .git .github .chrome-profile scripts test __pycache__ `
  /XF usage.db *.log *.tgz *.zip .gitignore .npmignore package-lock.json pnpm-lock.yaml `
  | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Write-Host "packed $($pkg.name)@$ver -> $dest"

# ---- relink the profile so "pack + restart" is the whole test loop ----
$profileDir = Join-Path $homeDsh "profiles\desktop"
$link = Join-Path (Join-Path $profileDir "node_modules") $pkg.name
$profilePkgJson = Join-Path $profileDir "package.json"

# 1) junction: re-point whenever the target version changed (or is missing).
$linkTarget = $null
if (Test-Path $link) {
  $item = Get-Item $link -Force
  $t = $item.Target
  if ($t -is [array]) { $t = ($t -join '') }
  $linkTarget = [string]$t
}
if ($linkTarget -ne $dest) {
  if (Test-Path $link) {
    cmd /c rmdir "$link" | Out-Null   # removes the junction only, never the target dir
    if (Test-Path $link) { throw "could not remove old junction $link (target in use?)" }
  }
  New-Item -ItemType Junction -Path $link -Target $dest | Out-Null
  Write-Host "junction -> $dest"
} else {
  Write-Host "junction already -> $dest"
}

# 2) profile package.json dependency: keep the format DSH accepts
#    ("link:<path>" with forward slashes), preserve the file's formatting, and
#    ALWAYS write UTF-8 WITHOUT BOM - DSH's JSON parser rejects a BOM.
if (-not (Test-Path $profilePkgJson)) { throw "profile package.json not found: $profilePkgJson" }
$text = [System.IO.File]::ReadAllText($profilePkgJson)
if ($text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
$dep = 'link:' + ($dest -replace '\\', '/')
$depPattern = '("' + [regex]::Escape($pkg.name) + '"\s*:\s*")[^"]*(")'
if ($text -match $depPattern) {
  $text = [regex]::Replace($text, $depPattern, '$1' + $dep.Replace('$', '$$') + '$2')
  Write-Host "profile dep -> $dep"
} else {
  # Dependency row missing: insert it into the dependencies object.
  $m = [regex]::Match($text, '("dependencies"\s*:\s*\{)')
  if (-not $m.Success) { throw "profile package.json has no dependencies block - add `"$($pkg.name)`": `"$dep`" manually" }
  $text = $text.Substring(0, $m.Index + $m.Length) + "`n    `"$($pkg.name)`": `"$dep`"," + $text.Substring($m.Index + $m.Length)
  Write-Host "profile dep added -> $dep"
}
$null = $text | ConvertFrom-Json   # validate BEFORE writing back
[System.IO.File]::WriteAllText($profilePkgJson, $text, [System.Text.UTF8Encoding]::new($false))

# ---- release tarball (npm pack honours the "files" whitelist; client.js was
# built at the top of this script, before the install copy mirrored it) ----
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  # cmd /c swallows npm's stderr notices without PowerShell 5.1 turning them
  # into red NativeCommandError noise.
  cmd /c "npm pack --pack-destination . >NUL 2>&1"
  if (-not (Test-Path ("dsh-owui-chat2api-{0}.tgz" -f $pkg.version))) { throw "npm pack produced no tgz - run 'npm pack' manually" }
  Write-Host ("tgz -> dsh-owui-chat2api-{0}.tgz" -f $pkg.version)
} finally { Pop-Location }

Write-Host "next:"
Write-Host "  restart DSH Desktop   (that's all - the link is already switched)"
