# pack.ps1 - build the client bundle and produce the release tarball.
#
# The DSH plugin manager owns installation: it links this repository into the
# profile (package.json, node_modules, dsh.profile.bundles) and keeps
# pnpm-lock.yaml in sync. So this script only does the two things the manager
# cannot:
#
#   1. rebuild client.js - the esbuild artifact DSH's web shell loads, which is
#      NOT read from the working tree (only lib/*.js is);
#   2. run `npm pack` for the release tarball.
#
# It deliberately does NOT copy the repo into ~/.dsh/plugins/<name>-<version>,
# hand-edit the profile package.json, or create a junction any more. The manager
# owns those files now: writing them by hand makes the next install reconcile
# against manual state it did not create, which already downgraded another
# bundle (dshmarket 1.66.5 -> the stale 1.47.0 pin) once.
#
# Local test loop:
#
#   scripts\pack.ps1   ->   restart DSH Desktop
#
# A `link:` install reads this working tree directly, so nothing has to be
# copied - only client.js needs rebuilding. `-SkipPack` skips the tarball.
#
# Safe by construction: `npm pack` honours the "files" whitelist in
# package.json, and .npmignore keeps .chrome-profile/, usage.db, token.json and
# node_modules/ out of the tarball, so no live credentials or usage data ship.

param(
  [switch]$SkipPack
)
$ErrorActionPreference = "Stop"

# Build the client half FIRST: the tarball below packs it, and DSH's web shell
# loads it, so doing this any later would ship a stale client.js.
node (Join-Path $PSScriptRoot "build-client.mjs")
if ($LASTEXITCODE -ne 0) { throw "client bundle build failed" }

# repo root = parent of scripts/
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$pkg  = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$tgz  = "dsh-owui-chat2api-{0}.tgz" -f $pkg.version

if (-not $SkipPack) {
  Push-Location $repo
  try {
    # cmd /c swallows npm's stderr notices without PowerShell 5.1 turning them
    # into red NativeCommandError noise.
    cmd /c "npm pack --pack-destination . >NUL 2>&1"
    if (-not (Test-Path $tgz)) { throw "npm pack produced no tgz - run 'npm pack' manually" }
    Write-Host ("tgz -> {0}  ({1}@{2})" -f $tgz, $pkg.name, $pkg.version)
  } finally { Pop-Location }
}

# Report where each profile currently points, so a stale link is obvious: a
# link that is not this repo means DSH is running a copy, not the working tree.
$homeDsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
foreach ($name in @("desktop", "web")) {
  $link = Join-Path $homeDsh ("profiles\{0}\node_modules\{1}" -f $name, $pkg.name)
  if (-not (Test-Path $link)) { continue }
  $target = (Get-Item $link -Force).Target
  if ($target -is [array]) { $target = ($target -join "") }
  $target = [string]$target
  $state = if ($target -eq [string]$repo) { "linked to this repo" } else { "NOT this repo" }
  Write-Host ("profile {0} -> {1}  [{2}]" -f $name, $target, $state)
}

Write-Host ""
Write-Host "next: restart DSH Desktop (a linked install reads this working tree directly,"
Write-Host "      so there is nothing to copy; client.js was just rebuilt)"
