import os from 'os';

/**
 * Outcome of a spawn-gate check. `ok:true` clears the spawn; `ok:false`
 * carries a human-readable reason and a retry delay so the caller can
 * re-attempt the spawn later without counting the deferral as a crash.
 */
export type SpawnDecision =
  | { ok: true }
  | { ok: false; reason: string; retryMs: number };

/**
 * Manager-owned spawn governor (OOM Wave 2, Patch 6 / F2).
 *
 * The 2026-06-05 incident OOM-froze the whole Windows box: a crash-looping
 * agent respawned ~9x while the host was already starved of memory, and each
 * fresh PTY/V8 isolate init pushed commit-charge past the limit until the
 * daemon FatalOOM'd and PM2 re-launched it into the same starved host.
 *
 * This governor is consulted at the top of EVERY `AgentProcess.start()` path
 * (initial, manager-honored restart, session refresh, AND the crash-backoff
 * restart in handleExit — the path that actually OOM'd the box; see F2 in the
 * draft). When free memory is critically low it defers the spawn instead of
 * piling another child onto an already-pressured host.
 *
 * KNOWN LIMITATION (called out in the draft, intentionally not hidden):
 * `os.freemem()` reports physical free RAM, not Windows commit-charge
 * availability — and the incident's fatal signature (child V8 isolate init
 * failure) is consistent with commit/reserve exhaustion, which can diverge
 * from physical free RAM. So this is a risk-REDUCER with conservative
 * thresholds, NOT a proof that commit exhaustion cannot recur. The planned
 * fast-follow (rolling-window/concurrent spawn cap, or a Windows
 * `\Memory\Committed Bytes` probe) bounds churn regardless of the memory
 * metric.
 */
export class SpawnGovernor {
  /** Point-in-time host memory snapshot used by canSpawn(). */
  snapshot(): { freeMb: number; totalMb: number; freePercent: number } {
    const free = os.freemem();
    const total = os.totalmem();
    return {
      freeMb: Math.round(free / 1024 / 1024),
      totalMb: Math.round(total / 1024 / 1024),
      freePercent: total > 0 ? free / total : 0,
    };
  }

  /**
   * Decide whether a new agent process may spawn right now.
   *
   * Thresholds are env-overridable so an operator can tune them per host
   * without a code change:
   *   - CTX_MIN_FREE_MEM_MB      (default 1024) — absolute free-RAM floor
   *   - CTX_MIN_FREE_MEM_PERCENT (default 0.08) — relative free-RAM floor
   * Either floor being breached defers the spawn.
   */
  canSpawn(): SpawnDecision {
    const s = this.snapshot();
    const minFreeMb = Number(process.env.CTX_MIN_FREE_MEM_MB ?? 1024);
    const minFreePercent = Number(process.env.CTX_MIN_FREE_MEM_PERCENT ?? 0.08);
    if (s.freeMb < minFreeMb || s.freePercent < minFreePercent) {
      return {
        ok: false,
        retryMs: 60000,
        reason: `free_mem=${s.freeMb}MB/${s.totalMb}MB (${Math.round(s.freePercent * 100)}%) below ${minFreeMb}MB/${Math.round(minFreePercent * 100)}%`,
      };
    }
    return { ok: true };
  }
}
