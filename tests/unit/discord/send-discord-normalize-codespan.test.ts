/**
 * Sink-sweep companion to tests/unit/cli/send-telegram-normalize-codespan.test.ts
 * (2026-07-07 live-fire finding): send-discord shared the IDENTICAL
 * unconditional \n/\t normalize bug as send-telegram (same blind
 * .replace(/\\n/g,'\n').replace(/\\t/g,'\t') pattern, same code-span
 * corruption risk for paths like `C:\Users\cody\cortextos\tools\test`).
 * Proven RED against pre-fix bus.ts, GREEN after normalizeLiteralEscapesOutsideCodeSpans().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const postWebhookSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/discord/api.js', () => ({
  postWebhook: (...args: unknown[]) => postWebhookSpy(...args),
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'discord-codespan-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'discord-codespan-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
  mkdirSync(join(tempCtx, 'orgs', 'test-org'), { recursive: true });
  writeFileSync(
    join(tempCtx, 'orgs', 'test-org', 'secrets.env'),
    'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/abc\n',
  );

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.CTX_ORG = 'test-org';
  process.chdir(tempCwd);

  postWebhookSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  delete process.env.CTX_ORG;
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('send-discord: \\n/\\t normalize must not corrupt code-span path content', () => {
  it('the exact live-fire repro survives the normalize intact inside a code span', async () => {
    const input = 'path check: `C:\\Users\\cody\\cortextos\\tools\\test` should stay literal';
    await busCommand.parseAsync(['send-discord', input], { from: 'user' });

    const sentMessage = postWebhookSpy.mock.calls[0]?.[1] as string;
    expect(sentMessage).toBe(input);
    expect(sentMessage).not.toContain('\t');
  });

  it('outside a code span, literal \\n still normalizes (regression guard)', async () => {
    await busCommand.parseAsync(['send-discord', 'line1\\nline2'], { from: 'user' });
    const sentMessage = postWebhookSpy.mock.calls[0]?.[1] as string;
    expect(sentMessage).toBe('line1\nline2');
  });
});
