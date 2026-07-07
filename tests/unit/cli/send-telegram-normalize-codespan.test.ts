/**
 * Live-fire finding (2026-07-07, theta #41 re-fire): the PR-12 literal-
 * \n/\t normalize at src/cli/bus.ts (send-telegram, send-discord,
 * send-mobile-reply) is a blind global replace with no code-span awareness.
 * A Windows path inside a code span that happens to contain the literal
 * 2-char substring "\t" or "\n" (e.g. `C:\Users\cody\cortextos\tools\test`
 * — "\tools" and "\test" both collide) gets silently corrupted into real
 * TAB/newline characters BEFORE any downstream path-formatting logic
 * (including the theta #41 R1 rule) ever sees the text. This is
 * UNCONDITIONAL — not gated by CTX_TELEGRAM_FORMAT_GUARD — and was live in
 * production since PR-12, independent of the format-guard feature.
 *
 * This test is written to run RED against the pre-fix code (plain
 * message.replace(/\\n/g,'\n').replace(/\\t/g,'\t')) and GREEN once the
 * normalize is scoped to skip code-span content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalFlag: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'codespan-norm-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'codespan-norm-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalFlag = process.env.CTX_TELEGRAM_FORMAT_GUARD;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  // Flag OFF for this suite — proves the normalize bug independent of the
  // format-guard feature (the corruption predates and does not depend on it).
  delete process.env.CTX_TELEGRAM_FORMAT_GUARD;
  process.chdir(tempCwd);

  sendMessageSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalBotToken;
  if (originalFlag === undefined) delete process.env.CTX_TELEGRAM_FORMAT_GUARD;
  else process.env.CTX_TELEGRAM_FORMAT_GUARD = originalFlag;
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('send-telegram: \\n/\\t normalize must not corrupt code-span path content', () => {
  it('the exact live-fire repro: `C:\\Users\\cody\\cortextos\\tools\\test` survives the normalize intact (no real TAB chars)', async () => {
    const input = 'path check: `C:\\Users\\cody\\cortextos\\tools\\test` should stay literal';
    await busCommand.parseAsync(['send-telegram', '12345', input], { from: 'user' });

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe(input);
    // Sanity: no real tab/newline control chars leaked into the code span.
    expect(sentMessage).not.toContain('\t');
    expect(sentMessage).not.toContain('\n');
  });

  it('a path with \\new (n-collision) inside a code span also survives intact', async () => {
    const input = 'see `C:\\Users\\cody\\new\\notes.txt` for details';
    await busCommand.parseAsync(['send-telegram', '12345', input], { from: 'user' });

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe(input);
  });

  it('outside a code span, the literal \\n/\\t normalize still fires unconditionally (regression guard: fix must not disable the PR-12 behavior entirely)', async () => {
    const input = 'line1\\nline2\\tcol2 (no code span here)';
    await busCommand.parseAsync(['send-telegram', '12345', input], { from: 'user' });

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('line1\nline2\tcol2 (no code span here)');
  });

  it('mixed: real \\n/\\t normalize fires outside the span, path stays literal inside it', async () => {
    const input = 'header\\ntab\\tvalue then `C:\\temp\\test` path';
    await busCommand.parseAsync(['send-telegram', '12345', input], { from: 'user' });

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('header\ntab\tvalue then `C:\\temp\\test` path');
  });
});
