import { readdirSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * SessionEnd-hook end-type markers (see src/hooks/hook-crash-alert.ts). A
 * restart writes one of these; the crash-alert hook reads it WITHOUT consuming
 * it, because one restart fires the hook twice and both firings must classify
 * from the same marker. clearEndMarkers is the marker's primary cleanup: an
 * agent that is updating its heartbeat is genuinely alive in its post-restart
 * session — any pending end-marker is therefore stale and is removed here, so
 * it cannot misclassify a later genuine crash. The hook's own TTL is only the
 * backstop for a start that fails before ever heartbeating.
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

/** Remove any SessionEnd-hook end-type markers from an agent's state dir. */
export function clearEndMarkers(stateDir: string): void {
  for (const file of END_TYPE_MARKERS) {
    const p = join(stateDir, file);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore — best-effort cleanup */ }
    }
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

  // The agent is alive in its (post-restart) session — clear any stale
  // SessionEnd markers so the crash-alert hook cannot misclassify a later
  // genuine crash as a planned restart. This is the primary marker cleanup;
  // the hook's TTL is the failed-start backstop.
  clearEndMarkers(paths.stateDir);
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
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
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
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
