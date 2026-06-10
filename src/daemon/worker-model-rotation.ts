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

export type WorkerModelCohort = 'explicit' | 'default' | 'control';

export interface WorkerModelChoice {
  model: string;
  cohort: WorkerModelCohort;
  /** 0-based position in the persisted rotation; null for explicit spawns. */
  rotationIndex: number | null;
}

function rotationPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '_shared', ROTATION_FILE);
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
    return { model: WORKER_CONTROL_MODEL, cohort: 'control', rotationIndex: index };
  }
  return { model: WORKER_DEFAULT_MODEL, cohort: 'default', rotationIndex: index };
}
