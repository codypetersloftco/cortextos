import { join } from 'path';
import { readFileSync } from 'fs';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Phase-1 Sonnet worker-default rotation (exp_1781129540_te3sj).
 *
 * Ephemeral workers spawned WITHOUT an explicit --model no longer inherit the
 * session/account default: they get Sonnet, except every Nth default spawn
 * which runs the previous model (Fable 5) as a concurrent control cohort —
 * this kills the time-confound a pre/post comparison would have.
 *
 * The rotation counter is PERSISTED (state/_shared/worker-model-rotation.json)
 * so the every-Nth split survives daemon restarts; an in-memory counter would
 * reset on every restart and skew the cohort ratio. An explicit --model spawn
 * bypasses the rotation entirely and does NOT consume a counter slot.
 */

export const WORKER_DEFAULT_MODEL = 'claude-sonnet-4-6';
export const WORKER_CONTROL_MODEL = 'claude-fable-5';
export const CONTROL_EVERY_N = 4;

const ROTATION_FILE = 'worker-model-rotation.json';
const CONTROL_HEALTH_FILE = 'worker-control-health.json';

/** How long the control model is auto-skipped after a control-cohort spawn fails.
 *  After this, the rotation tries the control again — self-healing when the model
 *  (e.g. a pulled/temporarily-down Fable) comes back. */
export const CONTROL_UNAVAILABLE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

export type WorkerModelCohort = 'explicit' | 'default' | 'control' | 'control-skipped';

export interface WorkerModelChoice {
  model: string;
  cohort: WorkerModelCohort;
  /** 0-based position in the persisted rotation; null for explicit spawns. */
  rotationIndex: number | null;
}

function rotationPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '_shared', ROTATION_FILE);
}

function controlHealthPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '_shared', CONTROL_HEALTH_FILE);
}

/**
 * The control model to run for the control cohort, env-overridable at runtime.
 * - unset            -> the default experiment control (WORKER_CONTROL_MODEL)
 * - 'off'/'none'/'disabled'/'' -> control cohort DISABLED (Nth spawn uses the default
 *   model too) — lets ops pause a pulled/unavailable control model with NO daemon
 *   rebuild, just by setting the env on the next daemon start.
 * - any model id     -> run that as the control cohort.
 */
function configuredControlModel(): string | null {
  const raw = process.env.CTX_WORKER_CONTROL_MODEL;
  if (raw === undefined) return WORKER_CONTROL_MODEL;
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'off' || v.toLowerCase() === 'none' || v.toLowerCase() === 'disabled') {
    return null;
  }
  return v;
}

/** True if a recent control-cohort failure marked the control model unavailable
 *  and the cooldown has not yet elapsed. Read every spawn (no restart needed). */
function controlCurrentlyUnavailable(ctxRoot: string, now: number): boolean {
  try {
    const parsed = JSON.parse(readFileSync(controlHealthPath(ctxRoot), 'utf8'));
    const until = Number(parsed?.unavailable_until);
    return Number.isFinite(until) && until > now;
  } catch {
    return false; // no marker / unreadable -> treat as available
  }
}

/**
 * Mark the control model unavailable for a cooldown — called when a control-cohort
 * worker spawn FAILS (the model was pulled / is down). Self-heals: after the cooldown
 * the rotation retries the control, so a recovered model is picked up automatically.
 * Best-effort: a write failure must never break the caller.
 */
export function markControlUnavailable(
  ctxRoot: string,
  now: number = Date.now(),
  cooldownMs: number = CONTROL_UNAVAILABLE_COOLDOWN_MS,
): void {
  try {
    ensureDir(join(ctxRoot, 'state', '_shared'));
    atomicWriteSync(
      controlHealthPath(ctxRoot),
      JSON.stringify({
        unavailable_until: now + cooldownMs,
        marked_at: new Date(now).toISOString(),
      }),
    );
  } catch {
    // best-effort
  }
}

function readCount(file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const n = Number(parsed?.count);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0; // first spawn ever, or unreadable state — start the rotation over
  }
}

/**
 * Decide the model for a worker spawn and advance the persisted rotation.
 *
 * Never throws: a persistence failure costs cohort-split fidelity, not the
 * spawn itself.
 */
export function resolveWorkerModel(
  ctxRoot: string,
  explicitModel?: string,
): WorkerModelChoice {
  if (explicitModel) {
    return { model: explicitModel, cohort: 'explicit', rotationIndex: null };
  }

  const file = rotationPath(ctxRoot);
  const index = readCount(file);
  try {
    ensureDir(join(ctxRoot, 'state', '_shared'));
    atomicWriteSync(
      file,
      JSON.stringify({ count: index + 1, updated_at: new Date().toISOString() }),
    );
  } catch {
    // Persistence is best-effort — the spawn must not fail on a state write.
  }

  // Spawns 1..N-1 are Sonnet; spawn N is the control. (index is 0-based, so
  // index 3, 7, 11... with N=4.)
  if ((index + 1) % CONTROL_EVERY_N === 0) {
    const control = configuredControlModel();
    // Skip the control model when it's disabled (env) or recently-failed (cooldown)
    // and route the Nth spawn to the default model — so a pulled/unavailable control
    // model can NEVER fail 1-in-N spawns.
    if (control && !controlCurrentlyUnavailable(ctxRoot, Date.now())) {
      return { model: control, cohort: 'control', rotationIndex: index };
    }
    return { model: WORKER_DEFAULT_MODEL, cohort: 'control-skipped', rotationIndex: index };
  }
  return { model: WORKER_DEFAULT_MODEL, cohort: 'default', rotationIndex: index };
}
