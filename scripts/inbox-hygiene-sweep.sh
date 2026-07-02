#!/usr/bin/env bash
# Orphan-inbox hygiene sweep. Pairs with the roster-validation fix
# (task_1782943545090) so inbox-dir-existence becomes an HONEST recipient signal:
# archive every inbox/<name>/ that is not a live recipient, so a dead/retired name
# no longer has a lingering dir that would grandfather it past the validation.
#
# Dry-run by DEFAULT (no moves). Pass --execute to archive.
# KEEP (per Cody/boss ruling 2026-07-01): the 6 registry agents + reserved infra
# dirs + cd (live lead-dev session) + chief (KEPT until the crash-alert emitter fix
# lands — it is live evidence + the active target; archiving recreates it on the next
# alert). Everything else -> inbox/_archive/<name>/ (move; contents, incl the retired-
# pseudonym norma/sentinel/forge evidence, are PRESERVED). Non-empty dirs: full file
# list logged so nothing is silently discarded.
#
# --execute preconditions (prism blind-gate finding #3): a live worker/prestage
# inbox can be created dynamically (worker-process.ts:82) at any moment, or a
# message can land in a target dir between this script's listing and its mv — a
# TOCTOU race that would strand a live writer's message in an archived directory.
# Two layers of defense: (1) a fleet-quiet PRECONDITION that aborts the entire
# --execute run with ZERO moves if any non-KEEP dir shows recent activity or holds
# a live .lock.d; (2) a per-directory re-check immediately before each mv, since a
# long-running sweep leaves a gap between the global check and a later directory's
# turn. A final post-sweep pass reports (never auto-restores) any archived name
# that has already been recreated with new content, so a near-miss race is visible
# to the operator instead of silently vanishing.
set -euo pipefail

INBOX="${CTX_ROOT:?CTX_ROOT unset}/inbox"
ARCHIVE_DIR="${INBOX}/_archive"
MODE="${1:-dry-run}"
KEEP="analyst boss dbanalyst engineer penny prism _shared cd chief"   # _archive skipped separately
RECENT_SEC="${INBOX_SWEEP_RECENT_SEC:-300}"   # 5-minute activity window for the fleet-quiet assert

is_in() { case " $2 " in *" $1 "*) return 0;; *) return 1;; esac; }

LOG=""
if [ "$MODE" = "--execute" ]; then
  mkdir -p "$ARCHIVE_DIR"
  LOG="${ARCHIVE_DIR}/hygiene-sweep-$(date -u +%Y%m%dT%H%M%SZ).log"
  : > "$LOG"
fi
emit() { echo "$*"; if [ -n "$LOG" ]; then echo "$*" >> "$LOG"; fi; }

# Newest-file mtime (any depth) under a dir, or empty if the dir has no files.
# `|| true` guards the whole pipeline: under `set -e -o pipefail`, a bare failing
# find (e.g. the dir vanished mid-scan — itself a live-activity signal) would
# otherwise abort the whole sweep instead of just yielding "no recent file".
newest_file_under() {
  find "$1" -mindepth 1 -type f -newermt "-${RECENT_SEC} seconds" 2>/dev/null | head -1 || true
}

# Global precondition for --execute: fleet must be quiet. Checks EVERY non-KEEP
# inbox dir up front so a burst of live activity aborts the whole run with no
# moves, rather than archiving some dirs before hitting a live one.
assert_fleet_quiet() {
  local bad=0
  local d name lockdir recent
  for d in "$INBOX"/*/; do
    name=$(basename "$d")
    if [ "$name" = "_archive" ]; then continue; fi
    if is_in "$name" "$KEEP"; then continue; fi
    lockdir="${d}.lock.d"
    if [ -d "$lockdir" ]; then
      emit "PRECONDITION-FAIL: live lock at ${lockdir} (in-flight bus operation) — fleet not quiet"
      bad=1
    fi
    recent=$(newest_file_under "$d")
    if [ -n "$recent" ]; then
      emit "PRECONDITION-FAIL: recent activity in ${name} (${recent}) within last ${RECENT_SEC}s — fleet not quiet"
      bad=1
    fi
  done
  if [ "$bad" -ne 0 ]; then
    emit "ABORTED: --execute preconditions failed, 0 directories moved. Re-run when the fleet is quiet."
    exit 1
  fi
}

emit "=== INBOX HYGIENE SWEEP ($MODE) — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

if [ "$MODE" = "--execute" ]; then
  assert_fleet_quiet
fi

kept=0; archived=0; skipped_live=0
declare -a archived_names=()
for d in "$INBOX"/*/; do
  name=$(basename "$d")
  if [ "$name" = "_archive" ]; then continue; fi
  if is_in "$name" "$KEEP"; then kept=$((kept + 1)); continue; fi

  # Per-directory re-check right before mv (finding #3 layer 2): narrows the
  # TOCTOU gap between the global precondition and this directory's turn.
  if [ "$MODE" = "--execute" ]; then
    if [ -d "${d}.lock.d" ]; then
      emit "SKIP-LIVE  ${name}  (lock held — re-run later)"
      skipped_live=$((skipped_live + 1))
      continue
    fi
    recent=$(newest_file_under "$d")
    if [ -n "$recent" ]; then
      emit "SKIP-LIVE  ${name}  (recent activity: ${recent})"
      skipped_live=$((skipped_live + 1))
      continue
    fi
  fi

  # Full recursive file listing (finding #5): the prior version only checked
  # top-level *.json and claimed "full file list" — any nested file or non-json
  # message would have been silently omitted from the log while still being
  # moved. List every file at any depth so nothing is undocumented.
  files=$(find "$d" -mindepth 1 -type f -printf '%P ' 2>/dev/null || true)
  fc=$(printf '%s' "$files" | wc -w | tr -d ' ')
  emit "ARCHIVE  ${name}  (files=${fc})"
  if [ "$fc" -gt 0 ]; then emit "    contents: ${files}"; fi
  if [ "$MODE" = "--execute" ]; then
    # Guard: never clobber a prior archive of the same name.
    dest="${ARCHIVE_DIR}/${name}"
    if [ -e "$dest" ]; then dest="${dest}.$(date -u +%s)"; fi
    mv "$d" "$dest"
    emit "    -> moved to _archive/$(basename "$dest")"
    archived_names+=("$name")
  fi
  archived=$((archived + 1))
done
emit "=== SUMMARY: kept=${kept}  archived=${archived}  skipped-live=${skipped_live}  (mode=${MODE}) ==="
if [ "$MODE" != "--execute" ]; then emit "NOTE: dry-run — no files moved. Re-run with --execute to apply."; fi

# Post-sweep delta-restore report (finding #3 layer 3): if a name we just
# archived already has a directory again with content, a writer raced the mv —
# report it loudly rather than silently losing visibility. Deliberately does
# NOT auto-restore: the reappeared dir holds a NEW message unrelated to the
# just-archived contents, so mv-ing anything back would misattribute it. The
# name simply falls back into next sweep's normal candidate pool.
if [ "$MODE" = "--execute" ] && [ "${#archived_names[@]}" -gt 0 ]; then
  for name in "${archived_names[@]}"; do
    reappeared="${INBOX}/${name}"
    if [ -d "$reappeared" ]; then
      rc=$(find "$reappeared" -mindepth 1 -type f 2>/dev/null | wc -l | tr -d ' ' || true)
      if [ -n "$rc" ] && [ "$rc" -gt 0 ]; then
        emit "REAPPEARED-POST-SWEEP  ${name}  (files=${rc}) — a writer raced the archive mv; left in place for next sweep, nothing auto-restored"
      fi
    fi
  done
fi
