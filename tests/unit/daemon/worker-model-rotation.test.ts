import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveWorkerModel,
  markControlUnavailable,
  WORKER_DEFAULT_MODEL,
  WORKER_CONTROL_MODEL,
  CONTROL_EVERY_N,
} from '../../../src/daemon/worker-model-rotation.js';

describe('resolveWorkerModel — phase-1 Sonnet rotation', () => {
  let ctxRoot: string;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-rotation-test-'));
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  const rotationFile = () =>
    join(ctxRoot, 'state', '_shared', 'worker-model-rotation.json');

  it('explicit model wins, is tagged explicit, and does NOT consume a rotation slot', () => {
    const choice = resolveWorkerModel(ctxRoot, 'claude-opus-4-8');
    expect(choice).toEqual({
      model: 'claude-opus-4-8',
      cohort: 'explicit',
      rotationIndex: null,
    });

    // The rotation is untouched: the next default spawn is still index 0.
    const next = resolveWorkerModel(ctxRoot);
    expect(next.rotationIndex).toBe(0);
  });

  it('defaults to Sonnet with every Nth spawn on the Fable control', () => {
    const cohorts: string[] = [];
    const models: string[] = [];
    for (let i = 0; i < CONTROL_EVERY_N * 2; i++) {
      const c = resolveWorkerModel(ctxRoot);
      cohorts.push(c.cohort);
      models.push(c.model);
      expect(c.rotationIndex).toBe(i);
    }
    // Spawns 1..N-1 default, spawn N control — repeated for the second cycle.
    const expected = [
      ...Array(CONTROL_EVERY_N - 1).fill('default'), 'control',
      ...Array(CONTROL_EVERY_N - 1).fill('default'), 'control',
    ];
    expect(cohorts).toEqual(expected);
    expect(models.filter(m => m === WORKER_CONTROL_MODEL)).toHaveLength(2);
    expect(models.filter(m => m === WORKER_DEFAULT_MODEL)).toHaveLength(
      CONTROL_EVERY_N * 2 - 2,
    );
  });

  it('persists the counter to disk (survives a daemon restart)', () => {
    resolveWorkerModel(ctxRoot);
    resolveWorkerModel(ctxRoot);

    // Simulate a restart: nothing in memory, only the state file remains.
    const onDisk = JSON.parse(readFileSync(rotationFile(), 'utf8'));
    expect(onDisk.count).toBe(2);

    const afterRestart = resolveWorkerModel(ctxRoot);
    expect(afterRestart.rotationIndex).toBe(2);
  });

  it('a corrupt or missing state file restarts the rotation instead of throwing', () => {
    mkdirSync(join(ctxRoot, 'state', '_shared'), { recursive: true });
    writeFileSync(rotationFile(), 'not json{{{');
    const choice = resolveWorkerModel(ctxRoot);
    expect(choice.rotationIndex).toBe(0);
    expect(choice.cohort).toBe('default');
  });

  it('negative or non-integer persisted counts reset to 0', () => {
    mkdirSync(join(ctxRoot, 'state', '_shared'), { recursive: true });
    writeFileSync(rotationFile(), JSON.stringify({ count: -5 }));
    expect(resolveWorkerModel(ctxRoot).rotationIndex).toBe(0);
    writeFileSync(rotationFile(), JSON.stringify({ count: 'three' }));
    expect(resolveWorkerModel(ctxRoot).rotationIndex).toBe(0);
  });
});

describe('resolveWorkerModel — graceful control-model skip (env + self-heal)', () => {
  let ctxRoot: string;
  const ENV = 'CTX_WORKER_CONTROL_MODEL';
  let savedEnv: string | undefined;

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-rotation-skip-'));
    savedEnv = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  const nthChoice = () => {
    let c = resolveWorkerModel(ctxRoot);
    for (let i = 1; i < CONTROL_EVERY_N; i++) c = resolveWorkerModel(ctxRoot);
    return c; // the Nth (control slot)
  };

  it('env=off disables the control cohort — Nth spawn uses the default model, cohort control-skipped', () => {
    process.env[ENV] = 'off';
    const c = nthChoice();
    expect(c.model).toBe(WORKER_DEFAULT_MODEL);
    expect(c.cohort).toBe('control-skipped');
  });

  it('env override points the control cohort at a different model', () => {
    process.env[ENV] = 'claude-opus-4-8';
    const c = nthChoice();
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.cohort).toBe('control');
  });

  it('a fresh control-unavailable mark skips control (self-heal cooldown active)', () => {
    markControlUnavailable(ctxRoot, Date.now(), 60_000); // unavailable for 60s
    const c = nthChoice();
    expect(c.model).toBe(WORKER_DEFAULT_MODEL);
    expect(c.cohort).toBe('control-skipped');
  });

  it('an EXPIRED control-unavailable mark retries control (self-heals when model returns)', () => {
    markControlUnavailable(ctxRoot, Date.now() - 120_000, 60_000); // expired 60s ago
    const c = nthChoice();
    expect(c.model).toBe(WORKER_CONTROL_MODEL);
    expect(c.cohort).toBe('control');
  });
});

// ---------------------------------------------------------------------------
// spawnWorker instrumentation: worker_spawned / worker_redo events
// ---------------------------------------------------------------------------

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));

// The mock captures the onDone callback + records the last instance so a test
// can simulate a worker exit with a given code (exercises the self-heal trigger).
const workerInstances: any[] = [];
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    name: string;
    _onDone: ((name: string, code: number) => void) | null = null;
    constructor(name: string) { this.name = name; workerInstances.push(this); }
    onDone(cb: (name: string, code: number) => void) { this._onDone = cb; }
    async spawn() { /* no-op */ }
    isFinished() { return true; }
    fireExit(code: number) { this._onDone?.(this.name, code); }
  },
}));

// Mock the PTY-adjacent layers so no native bindings / HTTP load (same
// pattern as agent-manager.test.ts).
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    async start() {} async stop() {}
    getStatus() { return { status: 'stopped' }; }
    onExit() {}
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {},
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class { start() {} stop() {} },
}));

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager.spawnWorker — experiment instrumentation', () => {
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    logEventMock.mockClear();
    workerInstances.length = 0;
    const testDir = mkdtempSync(join(tmpdir(), 'cortextos-spawn-instr-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  function eventsNamed(name: string) {
    return logEventMock.mock.calls.filter(c => c[4] === name);
  }

  it('self-heal write-side: a CONTROL-cohort worker FAILURE writes the unavailable marker; default-failure + control-clean-exit do NOT', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const markerPath = join(ctxRoot, 'state', '_shared', 'worker-control-health.json');

    // 8 default spawns -> control cohort at rotation index 3 and 7 (CONTROL_EVERY_N=4).
    for (let i = 0; i < 8; i++) {
      await am.spawnWorker(`s${i}`, ctxRoot, 'task', 'engineer');
    }

    // A DEFAULT-cohort failure must NOT disable control (only control failures do).
    workerInstances[0].fireExit(1);
    expect(existsSync(markerPath)).toBe(false);

    // A CONTROL-cohort CLEAN exit (0) must NOT disable control.
    workerInstances[3].fireExit(0);
    expect(existsSync(markerPath)).toBe(false);

    // A CONTROL-cohort FAILURE writes the marker (the self-heal write-side = the defect this fixes).
    workerInstances[7].fireExit(1);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.unavailable_until).toBeGreaterThan(Date.now());
  });

  it('logs worker_spawned with model/cohort/task_class on a default spawn', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.spawnWorker('w1', ctxRoot, 'do the thing', 'engineer', undefined, {
      taskClass: 'extraction',
    });

    const spawned = eventsNamed('worker_spawned');
    expect(spawned).toHaveLength(1);
    const meta = spawned[0][6] as Record<string, unknown>;
    expect(meta.model).toBe(WORKER_DEFAULT_MODEL);
    expect(meta.cohort).toBe('default');
    expect(meta.rotation_index).toBe(0);
    expect(meta.task_class).toBe('extraction');
    expect(meta.parent).toBe('engineer');
    expect(meta.redo_of).toBeNull();
    expect(eventsNamed('worker_redo')).toHaveLength(0);
  });

  it('explicit model spawn is cohort=explicit and skips the rotation', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.spawnWorker('w2', ctxRoot, 'task', 'engineer', 'claude-fable-5');

    const meta = eventsNamed('worker_spawned')[0][6] as Record<string, unknown>;
    expect(meta.model).toBe('claude-fable-5');
    expect(meta.cohort).toBe('explicit');
    expect(meta.rotation_index).toBeNull();
    expect(meta.task_class).toBe('unclassified');
  });

  it('redoOf logs worker_redo on the parent with reason + task_class', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.spawnWorker('w3-r2', ctxRoot, 'task', 'engineer', undefined, {
      taskClass: 'build',
      redoOf: 'w3',
      redoReason: 'output rejected: hallucinated field map',
    });

    const redo = eventsNamed('worker_redo');
    expect(redo).toHaveLength(1);
    // Attributed to the parent (the rejecting party).
    expect(redo[0][1]).toBe('engineer');
    const meta = redo[0][6] as Record<string, unknown>;
    expect(meta.worker_name).toBe('w3-r2');
    expect(meta.redo_of).toBe('w3');
    expect(meta.reason).toBe('output rejected: hallucinated field map');
    expect(meta.task_class).toBe('build');
    expect(meta.model).toBe(WORKER_DEFAULT_MODEL);
  });

  it('every 4th default spawn runs the Fable control cohort', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    for (const n of ['c1', 'c2', 'c3', 'c4']) {
      await am.spawnWorker(n, ctxRoot, 'task', 'engineer');
    }
    const models = eventsNamed('worker_spawned').map(
      c => (c[6] as Record<string, unknown>).model,
    );
    expect(models).toEqual([
      WORKER_DEFAULT_MODEL, WORKER_DEFAULT_MODEL, WORKER_DEFAULT_MODEL,
      WORKER_CONTROL_MODEL,
    ]);
  });
});
