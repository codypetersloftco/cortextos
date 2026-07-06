// cortextOS Dashboard - Heartbeat data fetcher
// Reads directly from filesystem (heartbeats change frequently; SQLite may lag).

import fs from 'fs/promises';
import path from 'path';
import { CTX_ROOT, getHeartbeatPath } from '@/lib/config';
import type { Heartbeat, HealthStatus, AgentHealth, HealthSummary } from '@/lib/types';

// Default staleness thresholds (minutes) — used as the DOWN tier and as the
// fallback when an agent's own heartbeat-cron cadence can't be resolved
// (kept, not deleted: 'unknown'-cadence agents still need SOME severity
// tiering for the down/stale distinction, they just don't get the
// cadence-aware fresh/stale boundary — see resolveCadenceStaleness).
const STALE_THRESHOLD_MIN = 300; // 5 hours
const DOWN_THRESHOLD_MIN = 1440; // 24 hours

/**
 * Read one agent's crons.json directly (dashboard can't import src/bus/ —
 * separate Next.js app, no cross-src module path). Mirrors
 * src/bus/heartbeat.ts's readCronsForRoot exactly: same directory
 * convention (.cortextOS/state/agents/{agent}/crons.json), same
 * graceful-degradation contract (missing/corrupt -> []). Keep both in sync
 * if the crons.json schema or location ever changes.
 */
async function readCronsForAgent(agentName: string): Promise<Array<{ name: string; enabled: boolean; schedule: string }>> {
  const cronsFile = path.join(CTX_ROOT, '.cortextOS', 'state', 'agents', agentName, 'crons.json');
  try {
    const raw = JSON.parse(await fs.readFile(cronsFile, 'utf-8'));
    return Array.isArray(raw?.crons) ? raw.crons : [];
  } catch {
    return [];
  }
}

function parseDurationMs(interval: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(interval.trim());
  if (!match) return NaN;
  const n = parseInt(match[1], 10);
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * multipliers[match[2]];
}

/** Same conservative estimate as src/bus/cron-state.ts's cronExpressionMinIntervalMs. */
function cronExpressionMinIntervalMs(expr: string): number {
  const FALLBACK_MS = 48 * 3_600_000;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return FALLBACK_MS;
  const [minute, hour] = parts;
  const everyMin = /^\*\/(\d+)$/.exec(minute);
  if (everyMin && hour === '*') return parseInt(everyMin[1], 10) * 60_000;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return parseInt(everyHour[1], 10) * 3_600_000;
  if (/^\d+$/.test(hour)) return 24 * 3_600_000;
  return FALLBACK_MS;
}

const STALENESS_GRACE_FACTOR = 0.5;
const STALENESS_GRACE_FLOOR_MS = 10 * 60_000;

/**
 * Tri-state cadence-aware staleness (task_1783333452917): compares heartbeat
 * age against THIS agent's own heartbeat-cron interval, not a fixed
 * threshold — a fixed 5h/2h check silently misclassifies any agent whose
 * real cadence is longer (near-false-flagged every specialist, 6/11
 * incident) and can't distinguish "genuinely down" from "no cadence to
 * compare against at all" (workers, bridge entries like cd).
 */
export function resolveCadenceStaleness(
  heartbeat: Pick<Heartbeat, 'last_heartbeat'>,
  crons: Array<{ name: string; enabled: boolean; schedule: string }>,
  nowMs: number = Date.now(),
): 'fresh' | 'stale' | 'unknown' {
  const hbCron = crons.find((c) => c.name === 'heartbeat' && c.enabled);
  if (!hbCron || !heartbeat.last_heartbeat) return 'unknown';

  let cadenceMs = parseDurationMs(hbCron.schedule);
  if (isNaN(cadenceMs)) cadenceMs = cronExpressionMinIntervalMs(hbCron.schedule);
  if (isNaN(cadenceMs) || cadenceMs <= 0) return 'unknown';

  const ageMs = nowMs - new Date(heartbeat.last_heartbeat).getTime();
  if (isNaN(ageMs)) return 'unknown';

  const grace = Math.max(cadenceMs * STALENESS_GRACE_FACTOR, STALENESS_GRACE_FLOOR_MS);
  return ageMs > cadenceMs + grace ? 'stale' : 'fresh';
}

/**
 * Get heartbeat for a single agent. Returns null if not found.
 */
export async function getHeartbeat(agentName: string): Promise<Heartbeat | null> {
  const hbPath = getHeartbeatPath(agentName);
  try {
    const raw = await fs.readFile(hbPath, 'utf-8');
    const data = JSON.parse(raw);
    const hb: Heartbeat = {
      agent: agentName,
      org: data.org ?? '',
      status: data.status ?? 'unknown',
      current_task: data.current_task ?? undefined,
      mode: data.mode ?? undefined,
      last_heartbeat: data.last_heartbeat ?? data.timestamp ?? undefined,
      loop_interval: data.loop_interval ?? undefined,
      uptime_seconds: data.uptime_seconds ?? undefined,
    };
    const crons = await readCronsForAgent(agentName);
    hb.staleness = resolveCadenceStaleness(hb, crons);
    return hb;
  } catch {
    return null;
  }
}

/**
 * Get all heartbeats by scanning the state directory.
 */
export async function getAllHeartbeats(): Promise<Heartbeat[]> {
  const stateDir = path.join(CTX_ROOT, 'state');
  const heartbeats: Heartbeat[] = [];

  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    const results = await Promise.allSettled(
      dirs.map((d) => getHeartbeat(d.name))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        heartbeats.push(result.value);
      }
    }
  } catch {
    // state dir doesn't exist yet - return empty
  }

  return heartbeats;
}

/**
 * Get heartbeats filtered by org. If no org, returns all.
 */
export async function getHeartbeats(org?: string): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  if (!org) return all;
  // Include agents with matching org OR empty org (agents may not write org to heartbeat)
  return all.filter((hb) => hb.org === org || !hb.org);
}

/**
 * Compute health status from a heartbeat based on staleness.
 */
export function computeHealth(
  heartbeat: Heartbeat,
  thresholdMinutes?: number
): HealthStatus {
  return isAgentHealthy(heartbeat, thresholdMinutes) ? 'healthy' : 'stale';
}

/**
 * Check whether an agent heartbeat is healthy (not stale).
 *
 * Prefers the cadence-aware `staleness` verdict (set by getHeartbeat) when
 * present: 'stale' -> unhealthy, 'fresh'/'unknown' -> healthy ('unknown' —
 * no heartbeat cron known, e.g. a worker or bridge entry — is absence of
 * cadence data, not evidence of being down; the OLD fixed-threshold guess in
 * either direction was the false-flag bug this replaces). Only falls back to
 * the fixed `thresholdMinutes` check when staleness hasn't been computed
 * (e.g. a Heartbeat object built by hand rather than via getHeartbeat).
 */
export function isAgentHealthy(
  heartbeat: Heartbeat,
  thresholdMinutes: number = STALE_THRESHOLD_MIN
): boolean {
  if (!heartbeat.last_heartbeat) return false;

  if (heartbeat.staleness) {
    return heartbeat.staleness !== 'stale';
  }

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  return diffMinutes <= thresholdMinutes;
}

/**
 * Get detailed health status (healthy / stale / down).
 *
 * The healthy/not-healthy boundary uses the cadence-aware `staleness`
 * verdict when present (same rule as isAgentHealthy — keep both in sync).
 * DOWN_THRESHOLD_MIN stays a fixed 24h ceiling regardless of cadence: "down"
 * means genuinely dead, and even a long-cadence agent silent that long is
 * worth flagging, so this tier deliberately does NOT get cadence-aware.
 */
export function getHealthStatus(heartbeat: Heartbeat): HealthStatus {
  if (!heartbeat.last_heartbeat) return 'down';

  const lastBeat = new Date(heartbeat.last_heartbeat).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastBeat) / (1000 * 60);

  if (diffMinutes > DOWN_THRESHOLD_MIN) return 'down';

  const healthy = heartbeat.staleness
    ? heartbeat.staleness !== 'stale'
    : diffMinutes <= STALE_THRESHOLD_MIN;

  return healthy ? 'healthy' : 'stale';
}

/**
 * Get agents with stale or down heartbeats.
 */
export async function getStaleAgents(): Promise<Heartbeat[]> {
  const all = await getAllHeartbeats();
  return all.filter((hb) => !isAgentHealthy(hb));
}

/**
 * Get a health summary across all agents (optionally filtered by org).
 */
export async function getHealthSummary(org?: string): Promise<HealthSummary> {
  const heartbeats = await getHeartbeats(org);

  const summary: HealthSummary = {
    healthy: 0,
    stale: 0,
    down: 0,
    agents: [],
  };

  for (const hb of heartbeats) {
    const health = getHealthStatus(hb);

    if (health === 'healthy') summary.healthy++;
    else if (health === 'stale') summary.stale++;
    else summary.down++;

    summary.agents.push({
      agent: hb.agent,
      org: hb.org,
      health,
      lastHeartbeat: hb.last_heartbeat,
      currentTask: hb.current_task,
    });
  }

  return summary;
}
