import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import type { Readable, Writable } from 'stream';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { StdioJsonRpcClient, type JsonRpcResponse } from '../utils/stdio-json-rpc-client.js';

/**
 * Minimal child_process.ChildProcess shape the adapter needs. codex 0.98.0
 * speaks JSON-RPC over the child's stdin/stdout, so — unlike node-pty — the
 * stdio streams must be clean pipes (a PTY would interleave terminal control
 * sequences into the JSON stream). child_process.ChildProcess satisfies this
 * interface; tests inject a fake.
 */
interface ChildHandle {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface ChildSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: Array<'pipe' | 'ignore' | 'inherit'>;
  shell?: boolean;
  windowsHide?: boolean;
}

type SpawnFn = (file: string, args: string[], options: ChildSpawnOptions) => ChildHandle;

interface ThreadState {
  threadId: string;
  cwd: string;
  updatedAt: string;
}

interface ThreadResponse {
  thread: {
    id: string;
    status?: unknown;
  };
}

interface SkillsListResponse {
  data?: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      path: string;
      scope?: string;
      enabled?: boolean;
    }>;
  }>;
}

const THREAD_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const;

const TURN_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'dangerFullAccess' },
} as const;

const BOOTSTRAP_PATTERN = '[codex-app-server] ready';
const CODEX_ENTRYPOINT_REL = join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

/**
 * Resolve the codex CLI binary name to spawn as a fallback. Mirrors
 * AgentPTY.getBinaryName(). Used only when the codex.js entrypoint cannot be
 * located (see resolveCodexEntrypoint) — preferred path spawns node + codex.js
 * directly.
 *
 * On Windows, child_process cannot launch the extension-less npm shim and
 * refuses to spawn a `.cmd` without `shell:true` (Node's CVE-2024-27980 guard),
 * so probe PATH for `codex.exe` then `codex.cmd`. On non-Windows the bare
 * `codex` shim is directly executable.
 */
export function resolveCodexBinary(): string {
  if (platform() !== 'win32') return 'codex';
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  for (const ext of ['.exe', '.cmd']) {
    for (const dir of pathDirs) {
      if (existsSync(join(dir, `codex${ext}`))) {
        return `codex${ext}`;
      }
    }
  }
  return 'codex.cmd';
}

/**
 * Resolve the codex CLI's node entrypoint (`@openai/codex/bin/codex.js`) by
 * probing the PATH dirs that hold the `codex` shim. Spawning `node <codex.js>`
 * directly is exactly what the codex.cmd/shim does internally, but avoids both
 * the Windows `.cmd` EINVAL spawn guard and the `shell:true` arg-escaping
 * deprecation (DEP0190). Returns null if the entrypoint cannot be found, in
 * which case the caller falls back to resolveCodexBinary().
 */
export function resolveCodexEntrypoint(): string | null {
  // Windows drive letters contain colons (C:\...), so only `;` separates PATH
  // entries there; POSIX uses `:`.
  const sep = platform() === 'win32' ? ';' : ':';
  const pathDirs = (process.env.PATH || '').split(sep).filter(Boolean);
  for (const dir of pathDirs) {
    const hasShim = existsSync(join(dir, 'codex'))
      || existsSync(join(dir, 'codex.cmd'))
      || existsSync(join(dir, 'codex.exe'));
    if (!hasShim) continue;
    const entry = join(dir, CODEX_ENTRYPOINT_REL);
    if (existsSync(entry)) return entry;
  }
  return null;
}

const SLASH_REWRITE_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

/**
 * Codex app-server PTY adapter for cortextOS.
 *
 * Spawns a persistent `codex app-server` process and speaks newline-delimited
 * JSON-RPC over its stdin/stdout (codex-cli >= 0.98 dropped the `--listen`
 * unix-socket/WebSocket transport). The child is launched as `node
 * <@openai/codex/bin/codex.js> app-server` so the JSON-RPC streams are clean
 * pipes; see resolveCodexEntrypoint / resolveCodexBinary.
 */
export class CodexAppServerPTY {
  private _alive = false;
  private _executing = false;
  private _writeBuffer = '';
  private _turnQueue: unknown[][] = [];
  private _turnCompletion: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _spawnFn: SpawnFn | null = null;
  private _child: ChildHandle | null = null;
  private _rpc: StdioJsonRpcClient | null = null;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _cwd: string;
  private _threadStatePath: string;
  private _threadId: string | null = null;
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._threadStatePath = join(this._stateDir, 'codex-app-server-thread.json');
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexAppServerPTY already spawned. Kill first.');
    }

    ensureDir(this._stateDir);
    this._alive = true;

    try {
      await this.startAppServerWithRetry();
      await this.connectRpc();
      await this.initializeRpc();
      await this.startOrResumeThread(mode);
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
    } catch (err) {
      this._alive = false;
      this._outputBuffer.push(`[codex-app-server] degraded: ${err}\n`);
      this.kill();
      throw err;
    }
  }

  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.handleInput(content).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] input failed: ${err}\n`);
        });
      }
    } else {
      this._writeBuffer += data;
    }
  }

  kill(): void {
    this._alive = false;
    this._turnQueue = [];
    this.rejectTurnCompletion(new Error('Codex app-server stopped'));
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    if (this._child) {
      try {
        this._child.kill();
      } catch {
        // Ignore shutdown errors.
      }
      this._child = null;
    }
    this._onExitHandler?.(0, undefined);
    this._onExitHandler = null;
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._child?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
  }

  private async handleInput(content: string): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    if (input.startsWith('$')) {
      await this.handleSkillInput(input);
      return;
    }
    const slashMatch = input.match(SLASH_REWRITE_RE);
    if (slashMatch) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      await this.handleSkillInput(rewritten);
      return;
    }
    const turnText = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }]);
  }

  private extractTelegramPayload(
    content: string,
  ): { payload: string; replyDirective: string | null } | null {
    if (!content.startsWith('=== TELEGRAM')) return null;

    const headerMatch = content.match(/^=== TELEGRAM(?:\s+(PHOTO|DOCUMENT|VOICE|AUDIO|VIDEO|VIDEO_NOTE))?\s+from/);
    const mediaType = headerMatch?.[1] ?? null;

    const chatIdMatch = content.match(/^=== TELEGRAM[^\n]*\(chat_id:(-?\d+)\)/);
    const chatId = chatIdMatch?.[1] ?? null;

    const beforeReply = content
      .split('\n[Your last message:', 1)[0]
      .split('\nReply using:', 1)[0];

    const replyToContext = this.extractReplyToContext(beforeReply);
    const replyDirective = chatId
      ? `Reply via: cortextos bus send-telegram ${chatId} '<your reply>' — this is the only path that surfaces in Telegram and on the dashboard. Do not reply through the codex channel.`
      : null;
    const wrap = (payload: string | null): { payload: string; replyDirective: string | null } | null => {
      if (!payload) return null;
      const withReplyTo = replyToContext ? `${payload}\n\n${replyToContext}` : payload;
      return { payload: withReplyTo, replyDirective };
    };

    if (mediaType) {
      const mediaPayload = this.buildMediaPayload(mediaType, beforeReply);
      if (mediaPayload) return wrap(mediaPayload);
    }

    const lines = beforeReply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      if (line.startsWith('/') || line.startsWith('$')) return wrap(line);
      break;
    }

    const fencedBlocks = [...beforeReply.matchAll(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/g)];
    if (fencedBlocks.length > 0) {
      return wrap(fencedBlocks[fencedBlocks.length - 1]?.[1]?.trim() || null);
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      return wrap(line);
    }

    return null;
  }

  private buildMediaPayload(mediaType: string, beforeReply: string): string | null {
    // Match a dynamically-sized fence (3+ backticks): wrapFenceSafe grows the
    // fence to outlast any backtick run in the body, so the close must be the
    // same length as the open (backreference \1). Group 2 is the body.
    const captionMatch = beforeReply.match(/caption:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const caption = captionMatch?.[2]?.trim() ?? '';

    const transcriptMatch = beforeReply.match(/transcript:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const transcript = transcriptMatch?.[2]?.trim() ?? '';

    const localFileMatch = beforeReply.match(/^local_file:\s*(.+)$/m);
    const localFile = localFileMatch?.[1]?.trim() ?? '';

    const fileNameMatch = beforeReply.match(/^file_name:\s*(.+)$/m);
    const fileName = fileNameMatch?.[1]?.trim() ?? '';

    const durationMatch = beforeReply.match(/^duration:\s*(.+)$/m);
    const duration = durationMatch?.[1]?.trim() ?? '';

    const lines: string[] = [`[${mediaType}]`];
    if (caption) lines.push(`caption: ${caption}`);
    if (transcript) lines.push(`transcript: ${transcript}`);
    if (fileName) lines.push(`file_name: ${fileName}`);
    if (localFile) lines.push(`local_file: ${localFile}`);
    if (duration) lines.push(`duration: ${duration}`);

    return lines.length > 1 ? lines.join('\n') : null;
  }

  private extractReplyToContext(beforeReply: string): string | null {
    const telegramReplyMatch = beforeReply.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    if (telegramReplyMatch) {
      const text = telegramReplyMatch[1].slice(0, 200);
      if (text) return `[in reply to: ${text}]`;
    }

    const replyToMatch = beforeReply.match(/\[reply_to:\s*(\d+)\]/);
    if (!replyToMatch) return null;
    const messageId = replyToMatch[1];

    try {
      const outboundLog = join(this._stateDir, 'outbound-messages.jsonl');
      if (!existsSync(outboundLog)) return `[in reply to message ${messageId}]`;
      const fileLines = readFileSync(outboundLog, 'utf-8').split('\n').filter((l) => l.trim());
      for (let i = fileLines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(fileLines[i]) as { message_id?: number | string; text?: string };
          if (entry.message_id !== undefined && String(entry.message_id) === messageId) {
            const text = (entry.text || '').slice(0, 200);
            return text ? `[in reply to: ${text}]` : `[in reply to message ${messageId}]`;
          }
        } catch {
          // skip malformed lines
        }
      }
      return `[in reply to message ${messageId}]`;
    } catch {
      return `[in reply to message ${messageId}]`;
    }
  }

  private async startAppServerWithRetry(): Promise<void> {
    const delays = [1000, 4000, 16000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        await this.startAppServer();
        return;
      } catch (err) {
        lastErr = err;
        this.cleanupSpawnAttempt();
        this._outputBuffer.push(`[codex-app-server] spawn attempt ${attempt + 1} failed: ${err}\n`);
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Build the spawn command for `codex app-server`. Prefers `node
   * <@openai/codex/bin/codex.js>` (clean pipes, no shell, no Windows .cmd
   * EINVAL); falls back to the platform codex binary (shell:true on win32 for
   * the .cmd shim). No `--listen` (stdio transport) and no `--enable goals`
   * (the goals feature was removed in codex 0.98).
   */
  private buildSpawnCommand(): { file: string; args: string[]; shell: boolean } {
    const appServerArgs = ['app-server'];
    // Make the agent's configured model authoritative via a `-c` config override
    // (value parsed as TOML). Without this, codex inherits ~/.codex/config.toml's
    // global `model`, which may be a model this CLI build rejects.
    if (this._config.model) {
      appServerArgs.push('-c', `model="${this._config.model}"`);
    }
    const entrypoint = resolveCodexEntrypoint();
    if (entrypoint) {
      return { file: process.execPath, args: [entrypoint, ...appServerArgs], shell: false };
    }
    const binary = resolveCodexBinary();
    return { file: binary, args: appServerArgs, shell: platform() === 'win32' };
  }

  private startAppServer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this._spawnFn) {
        const cp = require('child_process');
        this._spawnFn = (file: string, args: string[], options: ChildSpawnOptions) =>
          cp.spawn(file, args, options) as ChildHandle;
      }

      const spawnFn = this._spawnFn;
      const { file, args, shell } = this.buildSpawnCommand();
      const child = spawnFn(file, args, {
        cwd: this._cwd,
        env: this.buildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
      });

      this._child = child;
      let settled = false;
      let stderrTail = '';

      child.on('error', (...a: unknown[]) => {
        if (settled) return;
        settled = true;
        reject(a[0] instanceof Error ? a[0] : new Error(String(a[0])));
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        stderrTail = (stderrTail + text).slice(-2000);
        this._outputBuffer.push(text);
      });

      child.on('exit', (...a: unknown[]) => {
        if (this._child !== child) return;
        const code = typeof a[0] === 'number' ? a[0] : null;
        const signal = typeof a[1] === 'string' ? a[1] : undefined;
        this._child = null;
        this._alive = false;
        this.rejectTurnCompletion(new Error('Codex app-server exited'));
        if (!settled) {
          settled = true;
          reject(new Error(
            `codex app-server exited (code=${code} signal=${signal ?? '-'})`
            + (stderrTail.trim() ? `: ${stderrTail.trim()}` : ''),
          ));
          return;
        }
        // _onExitHandler's contract is numeric (shared with AgentPTY/node-pty);
        // child_process signals are string names, surfaced in the error/log
        // above rather than coerced to a meaningless number.
        this._onExitHandler?.(code ?? 0, undefined);
      });

      // No socket to wait on: the JSON-RPC readiness gate is the `initialize`
      // round-trip in initializeRpc(). Resolve once the process has survived a
      // short grace window (so a bad-args immediate-exit is caught here and
      // retried) without consuming stdout — the first stdout bytes are codex's
      // `initialize` response, which the StdioJsonRpcClient (attached in
      // connectRpc) must receive.
      setTimeout(() => {
        if (settled) return;
        if (!child.stdin || !child.stdout) {
          settled = true;
          reject(new Error('codex app-server spawned without stdio pipes'));
          return;
        }
        settled = true;
        resolve();
      }, 300);
    });
  }

  private async connectRpc(): Promise<void> {
    if (!this._child?.stdin || !this._child?.stdout) {
      throw new Error('codex app-server is not spawned');
    }
    this._rpc = new StdioJsonRpcClient(this._child.stdin, this._child.stdout);
    this._rpc.onMessage((message) => this.handleRpcMessage(message));
    await this._rpc.connect();
  }

  private async initializeRpc(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'cortextos',
        title: 'cortextOS',
        version: this.getPackageVersion(),
      },
      capabilities: { experimentalApi: true },
    });
    this._rpc?.notify('initialized');
  }

  private async startOrResumeThread(_mode: 'fresh' | 'continue'): Promise<void> {
    // INVARIANT: an agent may only ever resume ITS OWN persisted thread, or start a
    // brand-new one. We must NEVER adopt "the latest thread for this cwd" — every codex
    // agent runs with the same cwd (the shared working tree C:\Users\cody\cortextos), so
    // a cwd-scoped lookup returns a SIBLING agent's thread. That fallback caused prism to
    // resume dbanalyst's thread (prism ran as a 2nd Norma, 2026-06-24) when prism's own
    // thread/resume hit a transient JSON-RPC timeout on cold-start. `_mode` no longer
    // gates behavior: a persisted thread is resumed in either mode, otherwise we start fresh.
    const persisted = this.readThreadState();
    if (persisted) {
      // Retry transient resume failures (e.g. cold-start "JSON-RPC request timed out")
      // before giving up — a transient failure must never escalate into starting fresh
      // (let alone adopting a sibling). Only after the retries are exhausted do we treat
      // our own thread as unrecoverable.
      const resumeDelaysMs = [500, 1500];
      for (let attempt = 0; attempt <= resumeDelaysMs.length; attempt += 1) {
        try {
          const resumed = await this.request<ThreadResponse>('thread/resume', {
            threadId: persisted.threadId,
            cwd: this._cwd,
            ...THREAD_PERMISSION_OVERRIDES,
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.setThreadId(resumed.result?.thread.id || persisted.threadId);
          return;
        } catch (err) {
          this._outputBuffer.push(
            `[codex-app-server] persisted resume failed (attempt ${attempt + 1}/${resumeDelaysMs.length + 1}): ${err}\n`,
          );
          if (attempt < resumeDelaysMs.length) {
            await sleep(resumeDelaysMs[attempt]);
          }
        }
      }
      // Own thread is unrecoverable after retries. Start a FRESH thread — never adopt
      // another agent's latest-for-cwd thread.
      this._outputBuffer.push(
        `[codex-app-server] own thread ${persisted.threadId} unrecoverable after retries; starting a fresh thread (will NOT adopt another agent's latest-for-cwd thread)\n`,
      );
    }

    const started = await this.request<ThreadResponse>('thread/start', {
      cwd: this._cwd,
      ...THREAD_PERMISSION_OVERRIDES,
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.setThreadId(started.result!.thread.id);
  }

  private queueTurn(input: unknown[]): void {
    this._turnQueue.push(input);
    if (!this._executing) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && this._turnQueue.length > 0) {
      const input = this._turnQueue.shift()!;
      this._executing = true;
      try {
        await this.startTurn(input);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(input: unknown[]): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const completion = this.createTurnCompletion();
    await this.request('turn/start', { threadId: this._threadId, input, ...TURN_PERMISSION_OVERRIDES });
    await completion;
  }

  /**
   * Local-command reply: writes to the agent log AND mirrors back to Telegram.
   * Local commands (e.g. `$skill` errors) are handled inside the adapter
   * without an LLM turn, so the user only sees a response if we send it.
   */
  private replyLocal(text: string): void {
    this._outputBuffer.push(text + '\n');
    if (this._telegramApi && this._chatId) {
      this._telegramApi.sendMessage(this._chatId, text, undefined, { parseMode: null }).catch(() => {});
    }
  }

  private async handleSkillInput(content: string): Promise<void> {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    const [, skillName, trailingText] = match;
    const skills = await this.request<SkillsListResponse>('skills/list', {
      cwds: [this._cwd],
      forceReload: false,
    });
    const allSkills = (skills.result?.data || []).flatMap((entry) => entry.skills || []);
    const exact = allSkills.find((skill) => skill.enabled !== false && skill.name === skillName);
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    this.queueTurn(input);
  }

  private handleRpcMessage(message: unknown): void {
    if (!isRecord(message)) return;

    if ('method' in message && 'id' in message) {
      const method = String(message.method);
      const id = message.id as number | string;
      this._outputBuffer.push(`[codex-app-server] unsupported request: ${method}\n`);
      this.emitUnsupportedRequestEvent(method);
      this._rpc?.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      return;
    }

    if (!('method' in message)) return;
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};

    switch (method) {
      case 'thread/started':
        this._outputBuffer.push('[codex-app-server] thread started\n');
        break;
      case 'thread/status/changed':
        this._outputBuffer.push(`[codex-app-server] status ${JSON.stringify(params.status)}\n`);
        if (isRecord(params.status) && params.status.type === 'idle') {
          this.writeIdleFlag();
        } else {
          this.maybeFireTyping();
        }
        break;
      case 'turn/started':
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        this.writeIdleFlag();
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        this.resolveTurnCompletion();
        break;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
        this._outputBuffer.push(`[plan] ${JSON.stringify(params)}\n`);
        this.maybeFireTyping();
        break;
      case 'error':
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        this.rejectTurnCompletion(new Error(JSON.stringify(params)));
        break;
      case 'thread/tokenUsage/updated':
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'warning':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'skills/changed':
      case 'item/started':
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      default:
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
    }
  }

  private request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    if (!this._rpc) throw new Error('Codex app-server RPC is not connected');
    return this._rpc.request<T>(method, params);
  }

  private createTurnCompletion(timeoutMs = 30 * 60 * 1000): Promise<void> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._turnCompletion = null;
        reject(new Error('Timed out waiting for turn/completed'));
      }, timeoutMs);
      this._turnCompletion = { resolve, reject, timer };
    });
  }

  private resolveTurnCompletion(): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private emitUnsupportedRequestEvent(method: string): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'error',
        'codex_app_server_unsupported_request',
        'error',
        {
          runtime: 'codex-app-server',
          method,
          thread_id: this._threadId,
        },
      );
    } catch {
      // OutputBuffer warning above is the user-visible fallback.
    }
  }

  private setThreadId(threadId: string): void {
    this._threadId = threadId;
    const state: ThreadState = {
      threadId,
      cwd: this._cwd,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this._threadStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  /**
   * Translate a `thread/tokenUsage/updated` notification from codex-app-server
   * into the context_status.json shape consumed by the FastChecker context
   * monitor. Writes atomically; failures are non-fatal (observability only).
   *
   * Mapping (per codex schema ThreadTokenUsageUpdatedNotification):
   *   - used_percentage = total.totalTokens / cap * 100  (clamped to [0, 100])
   *   - context_window_size = modelContextWindow ?? config.codex_context_cap ?? 256000
   *   - exceeds_200k_tokens = total.totalTokens > 200000
   *   - current_usage.{input,output,cache_read} from total.{input,output,cachedInput}Tokens
   *   - session_id = current threadId
   */
  private writeContextStatus(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;
    const totalTokens = typeof total.totalTokens === 'number' ? total.totalTokens : null;
    if (totalTokens === null) return;

    const modelContextWindow = typeof tokenUsage.modelContextWindow === 'number'
      ? tokenUsage.modelContextWindow
      : null;
    const cap = modelContextWindow ?? this._config.codex_context_cap ?? 256000;
    const usedPct = cap > 0 ? Math.min(100, (totalTokens / cap) * 100) : null;

    const inputTokens = typeof total.inputTokens === 'number' ? total.inputTokens : 0;
    const outputTokens = typeof total.outputTokens === 'number' ? total.outputTokens : 0;
    const cachedInputTokens = typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0;

    const payload = JSON.stringify({
      used_percentage: usedPct,
      context_window_size: cap,
      exceeds_200k_tokens: totalTokens > 200000,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: 0,
      },
      session_id: this._threadId,
      written_at: new Date().toISOString(),
    });

    try {
      atomicWriteSync(join(this._stateDir, 'context_status.json'), payload);
    } catch {
      // Non-fatal: FastChecker will skip stale/missing files gracefully.
    }
  }

  /**
   * Append a per-turn token usage record to <ctxRoot>/logs/<agent>/codex-tokens.jsonl
   * so the dashboard cost-parser can scan it alongside ~/.claude/projects/*.jsonl.
   * One JSONL line per `thread/tokenUsage/updated` notification; dedup by
   * (session_id, turn_id) is the parser's responsibility.
   */
  private appendCodexTokenLog(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;

    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (!turnId || !this._threadId) return;

    const entry = {
      timestamp: new Date().toISOString(),
      model: this._config.model || 'gpt-5-codex',
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
    };

    try {
      const logDir = join(this._env.ctxRoot, 'logs', this._env.agentName);
      ensureDir(logDir);
      appendFileSync(join(logDir, 'codex-tokens.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      // Non-fatal: cost reporting is observability only.
    }
  }

  private readThreadState(): ThreadState | null {
    if (!existsSync(this._threadStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._threadStatePath, 'utf-8')) as ThreadState;
      return parsed.cwd === this._cwd && parsed.threadId ? parsed : null;
    } catch {
      return null;
    }
  }

  private cleanupSpawnAttempt(): void {
    const child = this._child;
    this._child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Ignore failed attempt cleanup errors.
      }
    }
  }

  private writeIdleFlag(): void {
    try {
      writeFileSync(join(this._stateDir, 'last_idle.flag'), Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch {
      // Non-fatal.
    }
  }

  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    const keepVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch {
      // Ignore env file read errors.
    }
  }

  private getPackageVersion(): string {
    try {
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
