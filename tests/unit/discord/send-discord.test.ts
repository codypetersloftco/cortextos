import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the webhook poster so the test never hits the network.
const postWebhookSpy = vi.fn().mockResolvedValue(1);
vi.mock('../../../src/discord/api.js', () => ({
  postWebhook: (...args: unknown[]) => postWebhookSpy(...args),
}));

import { busCommand } from '../../../src/cli/bus';

describe('bus send-discord — outbound via webhook', () => {
  let tempCtx: string;
  let projectRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempCtx = mkdtempSync(join(tmpdir(), 'discord-ctx-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'discord-proj-'));
    // org secrets.env with the webhook url
    mkdirSync(join(projectRoot, 'orgs', 'testorg'), { recursive: true });
    writeFileSync(join(projectRoot, 'orgs', 'testorg', 'secrets.env'),
      'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/abc\n');
    mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
    // Agent dir MUST sit under the framework root or resolveEnv's env-leak
    // guard throws (it guards against a real agent's CTX_AGENT_DIR leaking in).
    const agentDir = join(projectRoot, 'orgs', 'testorg', 'agents', 'test-agent');
    mkdirSync(agentDir, { recursive: true });

    savedEnv = {
      CTX_ROOT: process.env.CTX_ROOT,
      CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
      CTX_AGENT_DIR: process.env.CTX_AGENT_DIR,
      CTX_ORG: process.env.CTX_ORG,
      CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
      CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
    };
    process.env.CTX_ROOT = tempCtx;
    process.env.CTX_AGENT_NAME = 'test-agent';
    process.env.CTX_AGENT_DIR = agentDir;
    process.env.CTX_ORG = 'testorg';
    process.env.CTX_PROJECT_ROOT = projectRoot;
    process.env.CTX_FRAMEWORK_ROOT = projectRoot;
    postWebhookSpy.mockClear();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(tempCtx, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reads DISCORD_WEBHOOK_URL from org secrets.env and posts the message', async () => {
    await busCommand.parseAsync(['send-discord', 'hello discord'], { from: 'user' });
    expect(postWebhookSpy).toHaveBeenCalledTimes(1);
    expect(postWebhookSpy.mock.calls[0][0]).toBe('https://discord.com/api/webhooks/1/abc');
    expect(postWebhookSpy.mock.calls[0][1]).toBe('hello discord');
  });

  it('normalizes literal \\n into real newlines before sending', async () => {
    await busCommand.parseAsync(['send-discord', 'line1\\nline2'], { from: 'user' });
    expect(postWebhookSpy).toHaveBeenCalledTimes(1);
    expect(postWebhookSpy.mock.calls[0][1]).toBe('line1\nline2');
  });
});
