/**
 * tests/unit/cli/bus-list-agents.test.ts
 *
 * Covers the `cortextos bus list-agents` CLI command surface specifically
 * (not just the shared `listAgents()` helper it duplicates). Prism's blind
 * gate on the reserved-agent-dir fix (50f7e84, task_1782994707262) found
 * this command has its own inline roster scan in src/cli/bus.ts that does
 * NOT call the shared helper and was NOT covered by isReservedAgentDirName()
 * — so `bus list-agents` still surfaced the phantom `_shared` avatar-assets
 * dir as an agent row even after the daemon/helper/recipient fixes landed.
 *
 * Repro (prism, live): `dist/cli.js bus list-agents --format json` returned
 * `{ "name": "_shared", "org": "...", "role": "", "enabled": false, ... }`.
 *
 * Isolation note: the list-agents action recomputes its own ctxRoot as
 * `join(os.homedir(), '.cortextos', env.instanceId)` (src/cli/bus.ts) rather
 * than honoring `resolveEnv().ctxRoot` (which WOULD respect a CTX_ROOT
 * override) — a pre-existing inconsistency, out of scope for this fix. So
 * this test cannot isolate via CTX_ROOT like tests/unit/cli/bus-crons.test.ts
 * does; instead it uses a throwaway unique CTX_INSTANCE_ID, which produces a
 * fresh, never-before-seen dir under the REAL home directory
 * (~/.cortextos/<unique-id>/), cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { homedir } from 'os';

const mockIpcSend = vi.fn().mockResolvedValue({ success: true, data: [] });
vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = vi.fn().mockResolvedValue(false);
  }
  return { IPCClient: MockIPCClient };
});

let frameworkRoot: string;
let instanceId: string;
let ctxRoot: string;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'bus-list-agents-fw-'));
  instanceId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

  // Real agent dir.
  mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
  // Reserved infra dir — mirrors the live orgs/loftco-autopilot/agents/_shared
  // avatar-assets dir that booted as a phantom agent (2026-07-02).
  mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', '_shared', 'avatars'), { recursive: true });
});

afterEach(() => {
  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;
  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;

  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(ctxRoot, { recursive: true }); } catch { /* ignore */ }

  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

describe('bus list-agents', () => {
  it('excludes the reserved _shared dir from the dir-scan (JSON output)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-agents', '--format', 'json']);

    const printed = logSpy.mock.calls.map(c => c[0]).join('\n');
    const results = JSON.parse(printed);
    expect(results.map((a: { name: string }) => a.name)).toEqual(['alice']);
  });

  it('excludes an underscore-prefixed name from the enabled-agents.json merge', async () => {
    const configDir = join(ctxRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'enabled-agents.json'),
      JSON.stringify({
        alice: { org: 'acme', enabled: true },
        _shared: { org: 'acme', enabled: false },
      }),
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-agents', '--format', 'json']);

    const printed = logSpy.mock.calls.map(c => c[0]).join('\n');
    const results = JSON.parse(printed);
    expect(results.map((a: { name: string }) => a.name)).toEqual(['alice']);
  });
});
