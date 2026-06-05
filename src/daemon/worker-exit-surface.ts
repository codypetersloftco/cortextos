import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { sendMessage } from '../bus/message.js';

/**
 * Surface a FAILED ephemeral-worker exit so it isn't silently lost.
 *
 * Background: the daemon's worker onDone callback previously discarded the exit
 * code — a failed worker was deleted from the registry exactly like a success,
 * with no durable, human-visible signal. The SessionEnd crash-alert hook cannot
 * cover this (it can't tell a clean from a failed worker, and a HARD crash fires
 * no SessionEnd at all). This runs at the daemon's `pty.onExit`, which fires for
 * BOTH a graceful non-zero exit AND a hard crash — the only layer that sees every
 * failure mode.
 *
 * On a non-zero exit it emits a durable `worker_failed` event (the PRIMARY,
 * activity-feed-visible signal) and best-effort messages the parent agent
 * (defense-in-depth — if the parent is offline the durable event still stands).
 * A clean exit (code 0) is silent. Never throws: failure-surfacing must not break
 * the daemon's worker cleanup.
 */
export function surfaceWorkerExit(
  instanceId: string,
  org: string,
  workerName: string,
  exitCode: number,
  parent: string | undefined,
): void {
  if (exitCode === 0) return; // clean completion — nothing to surface

  // Primary surface: a durable event in the org activity feed.
  try {
    const wpaths = resolvePaths(workerName, instanceId, org);
    logEvent(wpaths, workerName, org, 'action', 'worker_failed', 'error', {
      worker: workerName,
      exitCode,
      parent: parent ?? null,
    });
  } catch { /* never let surfacing throw */ }

  // Secondary surface: best-effort message to the parent that spawned it.
  if (parent) {
    try {
      const ppaths = resolvePaths(parent, instanceId, org);
      sendMessage(
        ppaths,
        workerName,
        parent,
        'high',
        `Worker "${workerName}" exited with code ${exitCode} (failed) — check its output/log.`,
      );
    } catch { /* best-effort; the durable event above is the primary surface */ }
  }
}
