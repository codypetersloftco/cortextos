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
set -euo pipefail

INBOX="${CTX_ROOT:?CTX_ROOT unset}/inbox"
ARCHIVE_DIR="${INBOX}/_archive"
MODE="${1:-dry-run}"
KEEP="analyst boss dbanalyst engineer penny prism _shared cd chief"   # _archive skipped separately

is_in() { case " $2 " in *" $1 "*) return 0;; *) return 1;; esac; }

LOG=""
if [ "$MODE" = "--execute" ]; then
  mkdir -p "$ARCHIVE_DIR"
  LOG="${ARCHIVE_DIR}/hygiene-sweep-$(date -u +%Y%m%dT%H%M%SZ).log"
  : > "$LOG"
fi
emit() { echo "$*"; if [ -n "$LOG" ]; then echo "$*" >> "$LOG"; fi; }

emit "=== INBOX HYGIENE SWEEP ($MODE) — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
kept=0; archived=0
for d in "$INBOX"/*/; do
  name=$(basename "$d")
  [ "$name" = "_archive" ] && continue
  if is_in "$name" "$KEEP"; then kept=$((kept + 1)); continue; fi
  files=$(find "$d" -maxdepth 1 -name '*.json' -printf '%f ' 2>/dev/null || true)
  fc=$(printf '%s' "$files" | wc -w | tr -d ' ')
  emit "ARCHIVE  ${name}  (files=${fc})"
  if [ "$fc" -gt 0 ]; then emit "    contents: ${files}"; fi
  if [ "$MODE" = "--execute" ]; then
    # Guard: never clobber a prior archive of the same name.
    dest="${ARCHIVE_DIR}/${name}"
    if [ -e "$dest" ]; then dest="${dest}.$(date -u +%s)"; fi
    mv "$d" "$dest"
    emit "    -> moved to _archive/$(basename "$dest")"
  fi
  archived=$((archived + 1))
done
emit "=== SUMMARY: kept=${kept}  archived=${archived}  (mode=${MODE}) ==="
if [ "$MODE" != "--execute" ]; then emit "NOTE: dry-run — no files moved. Re-run with --execute to apply."; fi
