/**
 * Theta #41: `cortextos bus send-telegram` applies the telegram-format-guard
 * (R1 backslash-path-in-code-span, R2 illegal-escape stripping) behind
 * CTX_TELEGRAM_FORMAT_GUARD (default OFF), AFTER the existing \n/\t
 * normalize and BEFORE the message reaches TelegramAPI.sendMessage.
 * Skipped entirely in --plain-text mode (no Markdown semantics to fix).
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
  tempCtx = mkdtempSync(join(tmpdir(), 'theta41-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'theta41-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalFlag = process.env.CTX_TELEGRAM_FORMAT_GUARD;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
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

describe('theta #41: send-telegram format-guard wiring', () => {
  it('does NOT apply the guard when CTX_TELEGRAM_FORMAT_GUARD is unset (default OFF)', async () => {
    delete process.env.CTX_TELEGRAM_FORMAT_GUARD;
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'path `C:\\Users\\cody\\x.txt` done\\!'],
      { from: 'user' },
    );
    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    // Unguarded: raw backslashes and escape survive untouched.
    expect(sentMessage).toBe('path `C:\\Users\\cody\\x.txt` done\\!');
  });

  it('applies R1+R2 when CTX_TELEGRAM_FORMAT_GUARD is enabled', async () => {
    process.env.CTX_TELEGRAM_FORMAT_GUARD = '1';
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'path `C:\\Users\\cody\\x.txt` done\\!'],
      { from: 'user' },
    );
    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('path `C:/Users/cody/x.txt` done!');
  });

  it('skips the guard in --plain-text mode even when the flag is enabled', async () => {
    process.env.CTX_TELEGRAM_FORMAT_GUARD = '1';
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'path `C:\\Users\\cody\\x.txt` done\\!', '--plain-text'],
      { from: 'user' },
    );
    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('path `C:\\Users\\cody\\x.txt` done\\!');
  });

  it('runs the guard AFTER the existing \\n/\\t normalize, not before', async () => {
    process.env.CTX_TELEGRAM_FORMAT_GUARD = '1';
    // Literal '\n' (2-char) should become a real newline first, then the
    // guard runs on the normalized text (no interaction expected here, but
    // proves ordering doesn't corrupt the earlier normalize).
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'line1\\nline2 `C:\\a\\b`'],
      { from: 'user' },
    );
    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('line1\nline2 `C:/a/b`');
  });

  it('a malformed/adversarial input never blocks the send (fail-open, live-fire style)', async () => {
    process.env.CTX_TELEGRAM_FORMAT_GUARD = '1';
    // Degenerate input: unmatched backtick, trailing backslash, mixed
    // escapes. Must still send SOMETHING, never throw.
    const weird = 'unmatched ` backtick \\\\ trailing\\\\';
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', weird], { from: 'user' }),
    ).resolves.not.toThrow();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});
