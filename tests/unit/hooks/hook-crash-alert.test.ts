import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { mkdirSync } from 'fs';
import { EventEmitter } from 'events';
import { readMaxCrashesPerDay, notifyAgents, resolveOrchestratorRecipient, classifyFromMarkers, isEphemeralWorkerExit, consumeEphemeralWorkerMarker, readHookInput } from '../../../src/hooks/hook-crash-alert';
import { clearEndMarkers } from '../../../src/bus/heartbeat';

describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

// Prism blind-gate finding #2 (bus-roster-validation fix-loop, 2026-07-01/02):
// CTX_ORCHESTRATOR_AGENT must resolve through the alias map + roster, not a raw
// `|| 'boss'` fallback — else an unset/bad/typo'd value gets hard-rejected by
// the roster-validated send-message and the orchestrator's crash-alert copy
// silently vanishes (fire-and-forget execFile swallows the rejection).
describe('resolveOrchestratorRecipient', () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-orch-'));
    savedEnv.CTX_ROOT = process.env.CTX_ROOT;
    savedEnv.CTX_ORCHESTRATOR_AGENT = process.env.CTX_ORCHESTRATOR_AGENT;
    savedEnv.CTX_FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT;
    savedEnv.CTX_PROJECT_ROOT = process.env.CTX_PROJECT_ROOT;

    process.env.CTX_ROOT = tmp;
    // Empty framework root (no orgs/ dir) so listAgents relies solely on
    // enabled-agents.json below — same pattern as bus/agents.test.ts.
    process.env.CTX_FRAMEWORK_ROOT = join(tmp, 'framework');
    delete process.env.CTX_PROJECT_ROOT;

    const configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({
        boss: { org: 'acme', enabled: true },
        analyst: { org: 'acme', enabled: true },
        dbanalyst: { org: 'acme', enabled: true },
      }),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const key of Object.keys(savedEnv)) {
      const val = savedEnv[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('defaults to boss when CTX_ORCHESTRATOR_AGENT is unset', () => {
    delete process.env.CTX_ORCHESTRATOR_AGENT;
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('defaults to boss when CTX_ORCHESTRATOR_AGENT is empty', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = '';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('passes through a valid known agent (boss)', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'boss';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('passes through a valid known agent (analyst)', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'analyst';
    expect(resolveOrchestratorRecipient(undefined)).toBe('analyst');
  });

  it('resolves the template-default "chief" alias to boss', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'chief';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('resolves the template-default "orchestrator" alias to boss', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'orchestrator';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('resolves the retired pseudonym "norma" to its registry name dbanalyst', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'norma';
    expect(resolveOrchestratorRecipient(undefined)).toBe('dbanalyst');
  });

  it('falls back to boss for an unresolvable typo/garbage value instead of passing it through', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'totally-unknown-agent';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('falls back to boss for a malformed value (rejects before any roster lookup)', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = '../etc/passwd';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });

  it('is case-insensitive on the input', () => {
    process.env.CTX_ORCHESTRATOR_AGENT = 'BOSS';
    expect(resolveOrchestratorRecipient(undefined)).toBe('boss');
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifyFromMarkers', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-markers-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no marker present → endType crash', () => {
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('fresh marker → classified by type, with its reason', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    const r = classifyFromMarkers(tmp, MARKERS);
    expect(r.endType).toBe('planned-restart');
    expect(r.reason).toBe('planned reboot');
  });

  it('does NOT consume the marker — both firings of a restart see it', () => {
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    // Firing #1 — the dying PTY's SessionEnd.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    // Firing #2 — the next PTY's fresh-launch cleanup. Marker must still be
    // there: this is the FP that the old unlink-on-read code produced.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
  });

  it('marker older than the TTL → treated as stale: ignored AND lazy-unlinked', () => {
    const markerPath = join(tmp, '.restart-planned');
    writeFileSync(markerPath, 'stale planned restart', 'utf-8');
    // Simulate a marker whose first-heartbeat clear never fired (failed
    // start): classify with a "now" well past the 5-minute TTL.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const r = classifyFromMarkers(tmp, MARKERS, farFuture);
    expect(r.endType).toBe('crash'); // stale marker must NOT mask a real crash
    expect(existsSync(markerPath)).toBe(false); // lazy-unlinked
  });

  it('first matching marker wins (precedence order preserved)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned', 'utf-8');
    writeFileSync(join(tmp, '.user-stop'), 'stopped', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
  });
});

describe('isEphemeralWorkerExit (marker-only gate)', () => {
  let tmp: string;
  const MARKER = '.cortextos-ephemeral-worker'; // mirrors WorkerProcess.EPHEMERAL_MARKER

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-ephemeral-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('true: ephemeral marker present → reclassify to worker-complete (regardless of how it exited)', () => {
    writeFileSync(join(tmp, MARKER), 'prestage-shippers-worker 2026-06-04', 'utf-8');
    expect(isEphemeralWorkerExit(tmp)).toBe(true);
  });

  it('false: NO ephemeral marker → persistent agent, stays crash (byte-unchanged path)', () => {
    expect(isEphemeralWorkerExit(tmp)).toBe(false);
  });

  it('false: cwd undefined', () => {
    expect(isEphemeralWorkerExit(undefined)).toBe(false);
  });
});

describe('consumeEphemeralWorkerMarker (last-reader cleanup)', () => {
  let tmp: string;
  const MARKER = '.cortextos-ephemeral-worker';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-consume-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // The daemon no longer removes the marker on worker exit (it raced this hook).
  // This hook is the marker's last reader and removes it AFTER reading, so a
  // stale marker can't mislead a future session that reuses the worker dir.
  it('removes the marker after the hook has read it', () => {
    writeFileSync(join(tmp, MARKER), 'prestage-shippers-worker 2026-06-08', 'utf-8');
    expect(isEphemeralWorkerExit(tmp)).toBe(true); // read first
    consumeEphemeralWorkerMarker(tmp);             // then consume
    expect(existsSync(join(tmp, MARKER))).toBe(false);
  });

  it('is a safe no-op when the marker is absent', () => {
    expect(() => consumeEphemeralWorkerMarker(tmp)).not.toThrow();
  });

  it('is a safe no-op when cwd is undefined', () => {
    expect(() => consumeEphemeralWorkerMarker(undefined)).not.toThrow();
  });
});

describe('readHookInput reads the SessionEnd `reason` key (rename-regression guard)', () => {
  // The SessionEnd stdin key is `reason`, NOT `end_reason` (verified against the
  // raw payload). This asserts the code parses `reason` so a future rename back
  // to a phantom key regresses loudly.
  function withMockStdin(payload: string, run: () => Promise<unknown>): Promise<unknown> {
    const fake = new EventEmitter() as unknown as NodeJS.ReadStream;
    const orig = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    const p = run();
    (fake as unknown as EventEmitter).emit('data', Buffer.from(payload));
    (fake as unknown as EventEmitter).emit('end');
    return p.finally(() => Object.defineProperty(process, 'stdin', orig));
  }

  it('parses reason="other" from a real SessionEnd payload', async () => {
    const payload = JSON.stringify({
      session_id: 's1', transcript_path: 't', cwd: 'X',
      hook_event_name: 'SessionEnd', reason: 'other',
    });
    const r = (await withMockStdin(payload, readHookInput)) as { reason?: string; cwd?: string };
    expect(r.reason).toBe('other');
    expect(r.cwd).toBe('X');
  });
});

describe('clearEndMarkers (via heartbeat)', () => {
  let tmp: string;
  const ALL = ['.restart-planned', '.session-refresh', '.user-restart', '.user-stop', '.daemon-stop'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-clear-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a post-grace heartbeat removes every pending end-type marker', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs well past the grace window — the markers are no longer in-flight.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(false);
  });

  it('leaves a fresh (within-grace) marker in place — an in-flight restart', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs ≈ marker mtime → every marker is within the grace window.
    clearEndMarkers(tmp);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(true);
  });

  it('is a no-op when no markers are present', () => {
    expect(() => clearEndMarkers(tmp)).not.toThrow();
  });
});

describe('marker lifecycle (classify → clearEndMarkers → classify)', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('both restart firings classify, a post-grace heartbeat clears, then a real crash classifies as crash', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    // Firing #1 and #2 of the dying restart — both must see the marker.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    // Post-restart session heartbeats past the grace window → marker cleared.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(false);
    // A genuine crash AFTER the clear must classify as crash — not be masked.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('a heartbeat DURING the in-flight restart (within grace) does NOT wipe the marker — firing#2 still classifies', () => {
    // This is the Finding-1 race: a fast-booting successor heartbeats before
    // the dying restart's second SessionEnd firing lands.
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #1
    clearEndMarkers(tmp); // successor's first heartbeat — marker still within grace
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #2 — no false crash
  });
});
