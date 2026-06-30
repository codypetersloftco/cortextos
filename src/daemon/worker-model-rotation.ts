import { join } from 'path';
import { readFileSync } from 'fs';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

/**
 * Worker-default model selection.
 *
 * Ephemeral workers spawned WITHOUT an explicit --model get the DEFAULT model
 * (Sonnet). The Sonnet-vs-Fable control-cohort experiment (exp_1781129540_te3sj)
 * is RETIRED: Fable 5 was pulled, so hardcoding it as an every-Nth control made
 * 1-in-N default spawns fail. There is NO control cohort by default anymore.
 *
 * The control-overlay machinery is KEPT DORMANT for a future, OPT-IN experiment:
 * set CTX_WORKER_CONTROL_MODEL=<model id> to run that model as an every-Nth control
 * cohort, availability-GUARDED — a failed control spawn marks it unavailable for a
 * cooldown, the rotation auto-skips to the default, and retries after the cooldown,
 * so a pulled/unavailable control model can NEVER re-cause 1-in-N spawn failures.
 * Unset / '' / off / none / disabled = no control cohort (the retired default).
 *
 * The rotation counter is PERSISTED (state/_shared/worker-model-rotation.json) so an
 * opt-in every-Nth split survives daemon restarts. An explicit --model spawn bypasses
 * selection entirely and does NOT consume a counter slot.
 */

export const WORKER_DEFAULT_MODEL = 'claude-sonnet-4-6';
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
 * The control model for an OPT-IN control cohort, from env CTX_WORKER_CONTROL_MODEL.
 * The Sonnet-vs-Fable experiment is RETIRED, so there is NO hardcoded control default:
 * - unset / '' / 'off' / 'none' / 'disabled' -> null = NO control cohort (every spawn
 *   gets the default model — the retired default).
 * - any model id -> run that model as the every-Nth control cohort (availability-guarded).
 */
function configuredControlModel(): string | null {
  const raw = process.env.CTX_WORKER_CONTROL_MODEL;
  if (raw === undefined) return null;
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

  // Control cohort is OPT-IN (retired by default). Only when a control model is
  // configured (env) does every Nth spawn run it — and then only if it's not in a
  // failure cooldown, so a pulled/unavailable control model can NEVER fail 1-in-N
  // (it skips to the default + self-heals after the cooldown).
  const control = configuredControlModel();
  if (control && (index + 1) % CONTROL_EVERY_N === 0) {
    if (!controlCurrentlyUnavailable(ctxRoot, Date.now())) {
      return { model: control, cohort: 'control', rotationIndex: index };
    }
    return { model: WORKER_DEFAULT_MODEL, cohort: 'control-skipped', rotationIndex: index };
  }
  // RETIRED default: no control cohort -> every default spawn uses the default model.
  return { model: WORKER_DEFAULT_MODEL, cohort: 'default', rotationIndex: index };
}
