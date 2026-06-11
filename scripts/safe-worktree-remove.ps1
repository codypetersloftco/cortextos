<#
.SYNOPSIS
  Safely remove a git worktree that may contain junctions into the shared tree.

.DESCRIPTION
  `git worktree remove --force` RECURSES THROUGH directory junctions into
  their TARGET — a worktree carrying a node_modules junction pointed at the
  shared repo's node_modules gets the SHARED packages deleted (2026-06-11
  incident: ~59/108 packages including commander wiped, fleet-wide CLI
  MODULE_NOT_FOUND for ~4 minutes).

  This script enforces the mandatory teardown order:
    1. Refuse dirty worktrees (tracked changes) unless -Force.
    2. Enumerate every junction/symlink inside the worktree.
    3. Remove each reparse point WITHOUT recursing into its target
       ([System.IO.Directory]::Delete($path, $false)).
    4. git worktree remove (+ prune).
    5. Verify the shared node_modules still resolves (commander probe).

.EXAMPLE
  pwsh scripts/safe-worktree-remove.ps1 C:\Users\cody\ctx-wt-mybranch
#>
param(
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [string]$RepoRoot = "C:\Users\cody\cortextos",
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Some agent/tool pwsh contexts ship a degraded PATHEXT (observed: ".CPL"),
# which makes PowerShell classify EVERY .exe as a "document": pipelined
# invocations throw "Cannot run a document in the middle of a pipeline" and
# bare & invocations silently no-op (the 2026-06-11 diagnosis of the
# .cmd-shim/document-classification failure family). Self-heal before any
# external call.
if ($env:PATHEXT -notmatch '\.EXE') {
  $env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC'
}

# Agent/pwsh tool contexts may lack git on PATH — resolve it robustly.
# (No PS7-only syntax: this must also run under Windows PowerShell 5.1.)
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$git = if ($gitCmd) { $gitCmd.Source } else { $null }
if (-not $git) {
  foreach ($candidate in @("$env:ProgramFiles\Git\cmd\git.exe", "$env:ProgramFiles\Git\bin\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")) {
    if (Test-Path $candidate) { $git = $candidate; break }
  }
}
if (-not $git) { throw "git not found on PATH or in standard install locations." }

if (-not (Test-Path $WorktreePath)) {
  # Directory already gone — just clean the registry.
  & $git -C $RepoRoot worktree prune
  Write-Output "OK: $WorktreePath absent; worktree registry pruned."
  exit 0
}

$resolved = (Resolve-Path $WorktreePath).Path
if ($resolved -eq (Resolve-Path $RepoRoot).Path) {
  throw "Refusing: target is the main repo tree itself."
}

# 1. Dirty check (tracked changes only; untracked scratch is fine to lose).
$dirty = & $git -C $resolved status --porcelain | Where-Object { $_ -notmatch '^\?\?' }
if ($dirty -and -not $Force) {
  throw "Refusing: worktree has tracked changes (use -Force to override):`n$($dirty -join "`n")"
}

# 2+3. Remove every reparse point first, never recursing into targets.
$reparse = Get-ChildItem -Path $resolved -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
foreach ($rp in $reparse) {
  [System.IO.Directory]::Delete($rp.FullName, $false)
  Write-Output "junction removed: $($rp.FullName) -> $($rp.Target)"
}

# 4. Now the worktree contains only real files — safe to remove.
& $git -C $RepoRoot worktree remove $resolved --force
& $git -C $RepoRoot worktree prune

# 5. Verify the shared tree survived.
$probe = Join-Path $RepoRoot 'node_modules\commander\package.json'
if (-not (Test-Path $probe)) {
  throw "ALERT: shared node_modules probe FAILED ($probe missing) — run npm install in $RepoRoot immediately."
}
$count = (Get-ChildItem (Join-Path $RepoRoot 'node_modules') -Directory).Count
Write-Output "OK: worktree removed; shared node_modules intact ($count package dirs, commander probe passed)."
