import { readdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths, CronDefinition } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseDurationMs, cronExpressionMinIntervalMs } from './cron-state.js';
import { cronsPathFor } from './crons-schema.js';

/**
 * Tri-state per-agent staleness verdict (not boolean) — a fixed-threshold
 * boolean stale flag silently misclassifies workers and bridge entries (cd,
 * ephemeral prestage workers) that have no heartbeat cron at all: with no
 * cadence to compare against, "not stale" and "stale" are BOTH wrong guesses.
 * 'unknown' names that honestly instead of forcing a guess either way — the
 * same silent-0 failure mode as a filter matching nothing and reporting
 * false-green. See task_1783333452917 (cadence-aware staleness) and its
 * design origin: a fixed 2h/5h threshold near-false-flagged every specialist
 * with a longer heartbeat cadence (6/11 incident, prism hb_stale=true).
 */
export type HeartbeatStaleness = 'fresh' | 'stale' | 'unknown';

/**
 * Grace added on top of the agent's own heartbeat cron interval before
 * calling it stale — absorbs scheduling jitter and normal cron-fire delay,
 * not a second independent threshold. 50% of the interval, floored at 10
 * minutes so short cadences (e.g. every-15-minutes) still get a meaningful
 * buffer instead of flapping on ordinary timing noise.
 */
const STALENESS_GRACE_FACTOR = 0.5;
const STALENESS_GRACE_FLOOR_MS = 10 * 60_000;

/**
 * Resolve an agent's own heartbeat cadence in milliseconds from its crons
 * list, or NaN if no enabled "heartbeat"-named cron exists or its schedule
 * can't be resolved to an interval. Tries duration shorthand first ("12h"),
 * then falls back to estimating a 5-field cron expression's minimum interval
 * — the same two schedule shapes the daemon's own scheduler already handles
 * (see cron-scheduler.ts computeNextFireAt).
 */
function resolveOwnCadenceMs(crons: CronDefinition[]): number {
  const hbCron = crons.find(c => c.name === 'heartbeat' && c.enabled);
  if (!hbCron) return NaN;

  const asDuration = parseDurationMs(hbCron.schedule);
  if (!isNaN(asDuration)) return asDuration;

  const asCronExpr = cronExpressionMinIntervalMs(hbCron.schedule);
  return isNaN(asCronExpr) ? NaN : asCronExpr;
}

/**
 * Compute the tri-state staleness verdict for one heartbeat against the
 * agent's OWN cadence (not a fleet-wide fixed threshold).
 *
 * `crons` is the agent's own crons list (from readCrons/readAllHeartbeats'
 * caller) — pass `[]` for an agent with no crons.json (workers, bridge
 * entries) to correctly get 'unknown' rather than a guessed fresh/stale.
 */
export function resolveHeartbeatStaleness(
  heartbeat: Pick<Heartbeat, 'last_heartbeat'>,
  crons: CronDefinition[],
  nowMs: number = Date.now(),
): HeartbeatStaleness {
  const cadenceMs = resolveOwnCadenceMs(crons);
  if (isNaN(cadenceMs) || cadenceMs <= 0) return 'unknown';

  const ageMs = nowMs - new Date(heartbeat.last_heartbeat).getTime();
  if (isNaN(ageMs)) return 'unknown';

  const grace = Math.max(cadenceMs * STALENESS_GRACE_FACTOR, STALENESS_GRACE_FLOOR_MS);
  return ageMs > cadenceMs + grace ? 'stale' : 'fresh';
}

/**
 * SessionEnd-hook end-type markers (see src/hooks/hook-crash-alert.ts). A
 * restart writes one of these; the crash-alert hook reads it WITHOUT consuming
 * it, because one restart fires the hook twice and both firings must classify
 * from the same marker. clearEndMarkers is the marker's primary cleanup: an
 * agent updating its heartbeat is genuinely alive in its post-restart session,
 * so a pending end-marker is stale and is removed here — but only once it is
 * past the grace window below. The hook's TTL is the backstop for a start that
 * fails before ever heartbeating.
 */
const END_TYPE_MARKERS = [
  '.restart-planned',
  '.session-refresh',
  '.user-restart',
  '.user-disable',
  '.user-stop',
  '.daemon-crashed',
  '.daemon-stop',
];

/**
 * A marker younger than this is left alone by clearEndMarkers — it may belong
 * to a restart still in flight. The hazard: the post-restart session can reach
 * its first heartbeat before the dying restart's SECOND SessionEnd firing
 * lands (firing#2 is typically 13-22s after firing#1, but not hard-bounded).
 * Without a grace window, that heartbeat would wipe the marker and firing#2
 * would classify `crash` — the exact false positive this whole change exists
 * to kill, reintroduced under a narrower window.
 *
 * The grace makes that race negligible, not mathematically zero: a firing#2
 * delayed past 120s under heavy load could still miss the marker. That is the
 * same bounded residual as the hook's TTL and is accepted. The window is sized
 * generously on the TTL's cost asymmetry — too tight reopens the FP; too loose
 * only delays cleanup harmlessly (the heartbeat clears it on a later pass, and
 * the 300s hook TTL backstops). 120s clears any plausible firing#2 delay while
 * staying well under the TTL.
 */
const MARKER_CLEAR_GRACE_MS = 120_000; // 2 minutes

/**
 * Remove SessionEnd-hook end-type markers from an agent's state dir, skipping
 * any marker younger than MARKER_CLEAR_GRACE_MS (an in-flight restart whose
 * second hook firing may not have landed yet). `nowMs` is injectable for tests.
 */
export function clearEndMarkers(stateDir: string, nowMs: number = Date.now()): void {
  for (const file of END_TYPE_MARKERS) {
    const p = join(stateDir, file);
    if (!existsSync(p)) continue;
    try {
      if (nowMs - statSync(p).mtimeMs < MARKER_CLEAR_GRACE_MS) continue; // in-flight — leave it
      unlinkSync(p);
    } catch { /* ignore — best-effort cleanup */ }
  }
}

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = options?.timezone ? detectDayNightMode(options.timezone) : detectDayNightMode('UTC');

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? '',
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );

  // The agent is alive in its (post-restart) session — clear stale SessionEnd
  // markers so the crash-alert hook cannot misclassify a later genuine crash
  // as a planned restart. Markers inside the grace window are left in place
  // (an in-flight restart's second hook firing may not have landed); they are
  // cleared on a later heartbeat. This is the primary marker cleanup; the
  // hook's TTL is the failed-start backstop.
  clearEndMarkers(paths.stateDir);
}

/**
 * CH3: refresh ONLY the last_heartbeat timestamp from bus ACTIVITY, preserving
 * every other heartbeat field (status, current_task, mode, …). Liveness then =
 * "last bus activity", not just "last heartbeat-cron fire", so an agent actively
 * working via the bus between cron fires is not falsely flagged stale (the inverse
 * of the crash-alert false-positive). Called ONLY for SESSION-ORIGIN bus writes
 * (see the cli/bus.ts preAction gate); a hung session emits no bus writes, so this
 * never masks a real hang. Unlike updateHeartbeat it does NOT clearEndMarkers — a
 * routine bus write is not a post-restart liveness event. Best-effort: never throws.
 */
export function touchLastSeen(paths: BusPaths, agentName: string): void {
  try {
    ensureDir(paths.stateDir);
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    let hb: Partial<Heartbeat> = {};
    if (existsSync(hbPath)) {
      try { hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Partial<Heartbeat>; } catch { /* corrupt → minimal */ }
    }
    hb.agent = hb.agent ?? agentName;
    hb.last_heartbeat = ts;
    atomicWriteSync(hbPath, JSON.stringify(hb));
  } catch { /* liveness refresh must never break a bus command */ }
}

/**
 * CH3: the bus sub-commands whose execution proves the agent's live main loop is
 * doing work — a WRITE refreshes last_seen. Reads (check-inbox, list-*, ack-*,
 * recall, kb-query, …) are excluded: they don't prove ongoing work.
 */
export const LAST_SEEN_WRITE_OPS = new Set<string>([
  'send-message', 'log-event', 'create-task', 'update-task', 'claim-task', 'complete-task',
]);

/**
 * CH3 gate (testable): refresh last_seen iff this is a write-op AND not suppressed.
 * `suppressed` = the CTX_SUPPRESS_LAST_SEEN opt-out that non-live / on-behalf CLI
 * shell-outs (crash-alert teardown, hook-telemetry) set, so a daemon/teardown write
 * under an agent name never masks a hang. Daemon-DIRECT writes never reach the CLI
 * at all, so they are excluded structurally (not via this gate).
 */
export function shouldRefreshLastSeen(commandName: string, suppressed: boolean): boolean {
  return !suppressed && LAST_SEEN_WRITE_OPS.has(commandName);
}

/**
 * Detect day/night mode based on timezone.
 * Day: 8:00 - 22:00, Night: 22:00 - 8:00
 */
export function detectDayNightMode(timezone: string): 'day' | 'night' {
  try {
    const now = new Date();
    const formatted = now.toLocaleString('en-US', { timeZone: timezone, hour12: false, hour: '2-digit' });
    const hour = parseInt(formatted, 10);
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  } catch {
    // Fallback to UTC
    const hour = new Date().getUTCHours();
    return (hour >= 8 && hour < 22) ? 'day' : 'night';
  }
}

/**
 * Read one agent's crons list given an EXPLICIT ctxRoot, rather than going
 * through crons.ts's readCrons() (which resolves CTX_ROOT from the process
 * env — fine at runtime where env and paths.ctxRoot always agree, but wrong
 * for tests/callers that construct a BusPaths pointing elsewhere). Mirrors
 * crons.ts's own graceful-degradation contract: missing file or parse
 * failure both return [], never throw.
 */
export function readCronsForRoot(ctxRoot: string, agentName: string): CronDefinition[] {
  const cronsFile = join(ctxRoot, cronsPathFor(agentName));
  try {
    const raw = JSON.parse(readFileSync(cronsFile, 'utf-8'));
    return Array.isArray(raw?.crons) ? raw.crons : [];
  } catch {
    return [];
  }
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 *
 * Each returned heartbeat carries a `staleness` verdict computed against
 * THAT agent's own heartbeat-cron cadence (tri-state: fresh/stale/unknown —
 * see resolveHeartbeatStaleness) so every consumer (dashboard, metrics
 * report, fleet-health sweeps, liveness canaries) inherits cadence-aware
 * staleness for free instead of each guessing its own fixed threshold.
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      const hb: Heartbeat = JSON.parse(content);
      const crons = readCronsForRoot(paths.ctxRoot, agent);
      hb.staleness = resolveHeartbeatStaleness(hb, crons);
      heartbeats.push(hb);
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
