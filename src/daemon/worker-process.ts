import { join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';

/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - No session timer (workers run until task is complete)
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 */
export class WorkerProcess {
  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;
  // Backstop watchdog: a worker should finish its one-shot task and exit. If it
  // ever runs past this cap (e.g. a Stop hook blocks the exit), force-terminate
  // it so it can't hang for hours. The primary fix (CTX_EPHEMERAL_WORKER gating
  // the memory-checkpoint Stop hook) prevents the known hang; this bounds any
  // future one. Default 45min — well beyond normal worker runtime.
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEFAULT_MAX_RUNTIME_MS = 45 * 60 * 1000;
  // Filesystem signal that the memory-checkpoint Stop hook checks to skip ephemeral
  // workers. The hook receives `cwd` on stdin and looks for `<cwd>/<this file>`.
  // This is the RELIABLE signal: the env var CTX_EPHEMERAL_WORKER does not reliably
  // cross the node-pty/ConPTY → claude → bash-hook boundary on Windows, so a worker
  // could still hang in the blocking hook even with the var set. A file in the
  // worker's cwd (= AgentPTY cwd = this.dir) is env-independent and cross-platform.
  static readonly EPHEMERAL_MARKER = '.cortextos-ephemeral-worker';

  /** Absolute path to this worker's ephemeral marker (in its working dir = claude cwd). */
  private get markerPath(): string {
    return join(this.dir, WorkerProcess.EPHEMERAL_MARKER);
  }

  private writeMarker(): void {
    try {
      writeFileSync(this.markerPath, `${this.name} ${this.spawnedAt}\n`, 'utf-8');
    } catch { /* best-effort; watchdog is the backstop if this fails */ }
  }

  private removeMarker(): void {
    try {
      unlinkSync(this.markerPath);
    } catch { /* already gone / never written — fine */ }
  }

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(
    env: CtxEnv,
    prompt: string,
    config: { model?: string; maxRuntimeMs?: number } = {},
  ): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    // 5th arg = isEphemeralWorker: sets CTX_EPHEMERAL_WORKER=1 so the global
    // memory-checkpoint Stop hook skips this session (root-cause fix for the hang).
    this.pty = new AgentPTY(env, config, logPath, undefined, true);

    this.pty.onExit((code) => {
      this.clearWatchdog();
      // NOTE: deliberately do NOT removeMarker() here. This onExit fires
      // concurrently with the SessionEnd crash-alert hook (a separate process)
      // which reads the marker to classify the exit as a worker-complete (not a
      // crash). Removing the marker here raced that read — when the daemon won,
      // a clean ephemeral exit was mis-logged type=crash (task_1780941278942).
      // The hook is the marker's LAST reader and now owns its removal (consumes
      // it after reading). Cleanup still happens on terminate() and is
      // overwritten by writeMarker() on the next spawn in the same dir.
      this.exitCode = code;
      this.status = code === 0 ? 'completed' : 'failed';
      this.log(`Exited with code ${code} → ${this.status}`);
      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });

    // Write the ephemeral marker BEFORE the session starts so it exists by the time
    // the worker finishes its task and the Stop hook fires. Removed on exit/terminate.
    this.writeMarker();

    await this.pty.spawn('fresh', prompt);
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);

    // Arm the backstop watchdog.
    const maxRuntimeMs = config.maxRuntimeMs ?? WorkerProcess.DEFAULT_MAX_RUNTIME_MS;
    if (maxRuntimeMs > 0) {
      this.watchdog = setTimeout(() => {
        if (this.isFinished() || !this.pty) return;
        this.log(
          `Watchdog: exceeded max runtime (${Math.round(maxRuntimeMs / 60000)}min) — force-terminating (likely a hung Stop hook).`,
        );
        void this.terminate();
      }, maxRuntimeMs);
      // Don't let the watchdog keep the daemon event loop alive.
      this.watchdog.unref?.();
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    this.clearWatchdog();
    this.removeMarker();
    if (!this.pty) return;
    this.log('Terminating...');
    try {
      this.pty.write('\x03'); // Ctrl-C
      await sleep(500);
      this.pty.kill();
    } catch { /* ignore */ }
    this.status = 'completed';
    this.pty = null;
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty?.write(data), text);
    return true;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
    };
  }

  isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed';
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
