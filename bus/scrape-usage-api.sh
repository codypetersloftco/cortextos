#!/usr/bin/env bash
# OPT-A dashboard bridge: produce state/usage/latest.json (the shape the
# dashboard's getPlanUsage() reads) from the reliable check-usage-api.sh output.
#
# WHY: the dashboard Max Plan Usage panel reads latest.json in the PlanUsage
# shape {session,week_all_models,week_sonnet}, historically written by the old
# /usage TUI scrape (storeUsageData). The new OAuth-API path (check-usage-api.sh)
# is more reliable + cross-platform (post the Windows token fix) but emits a
# different shape (five_hour/seven_day utilization) to api-cache.json and never
# fed latest.json. This bridge maps the new output into latest.json so the panel
# shows real data, leaving the dashboard code untouched.
#
# Mapping (fields confirmed from check-usage-api.sh itself):
#   five_hour.utilization  -> session.used_pct       (+ resets_at -> session.resets)
#   seven_day.utilization  -> week_all_models.used_pct (+ resets_at -> resets)
#   week_sonnet.used_pct    = 0  (the OAuth usage API exposes no per-Sonnet number;
#                                 with Opus-everywhere this bar is not the signal)
#
# Safe-write: only overwrites latest.json when valid utilization is present, so a
# rate-limit (HTTP 429) or transient failure never clobbers the panel with zeros.
# Passes any args (e.g. --account, --force) through to check-usage-api.sh; relies
# on its 3-minute cache so this does not add API pressure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
AGENT="${CTX_AGENT_NAME:-fleet}"
USAGE_DIR="${CTX_ROOT}/state/usage"
mkdir -p "$USAGE_DIR"

RAW=$(bash "$SCRIPT_DIR/check-usage-api.sh" "$@" 2>/dev/null || true)

printf '%s' "$RAW" | AGENT="$AGENT" USAGE_DIR="$USAGE_DIR" python3 -c "
import sys, os, json, datetime
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    sys.stderr.write('{\"error\":\"check-usage-api produced no JSON (rate-limited or unavailable) — latest.json not updated\"}\n')
    sys.exit(1)
fh = d.get('five_hour') or {}
sd = d.get('seven_day') or {}
fh_u = fh.get('utilization')
sd_u = sd.get('utilization')
if fh_u is None and sd_u is None:
    sys.stderr.write('{\"error\":\"no valid utilization (rate-limited or unavailable) — latest.json not updated\"}\n')
    sys.exit(1)
out = {
    'agent': os.environ['AGENT'],
    'timestamp': datetime.datetime.utcnow().isoformat() + 'Z',
    'session': {'used_pct': fh_u if fh_u is not None else 0, 'resets': fh.get('resets_at', '') or ''},
    'week_all_models': {'used_pct': sd_u if sd_u is not None else 0, 'resets': sd.get('resets_at', '') or ''},
    'week_sonnet': {'used_pct': 0},
}
ud = os.environ['USAGE_DIR']
with open(os.path.join(ud, 'latest.json'), 'w', encoding='utf-8') as f:
    f.write(json.dumps(out, indent=2) + '\n')
day = out['timestamp'].split('T')[0]
with open(os.path.join(ud, day + '.jsonl'), 'a', encoding='utf-8') as f:
    f.write(json.dumps(out) + '\n')
print(json.dumps(out))
"
