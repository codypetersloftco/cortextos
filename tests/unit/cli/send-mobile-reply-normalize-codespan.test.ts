/**
 * Sink-sweep companion (2026-07-07 live-fire finding): send-mobile-reply
 * shared the IDENTICAL unconditional \n/\t normalize bug as send-telegram.
 * Proven RED against pre-fix bus.ts, GREEN after
 * normalizeLiteralEscapesOutsideCodeSpans().
 *
 * send-mobile-reply derives its own ctxRoot from CTX_INSTANCE_ID (not
 * CTX_ROOT directly) via `homedir()/.cortextos/<instanceId>`, and reads
 * `os`/`fs` via dynamic require() inside the action — mocking 'os' would
 * hit the dynamic-require-bypasses-vi.mock gap (see
 * tests/unit/**\/vitest-dynamic-require*), so this test uses a real,
 * unique throwaway CTX_INSTANCE_ID under the real home dir instead of
 * mocking, and cleans up afterward.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { busCommand } from '../../../src/cli/bus';

let instanceId: string;
let ctxRoot: string;
let originalInstanceId: string | undefined;
let originalAgentName: string | undefined;

beforeEach(() => {
  instanceId = `test-codespan-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
  originalInstanceId = process.env.CTX_INSTANCE_ID;
  originalAgentName = process.env.CTX_AGENT_NAME;
  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_AGENT_NAME = 'test-agent';
});

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = originalInstanceId;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  if (existsSync(ctxRoot)) rmSync(ctxRoot, { recursive: true, force: true });
});

function readLastOutbound(agent: string): { text: string } {
  const logFile = join(ctxRoot, 'logs', agent, 'outbound-messages.jsonl');
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('send-mobile-reply: \\n/\\t normalize must not corrupt code-span path content', () => {
  it('the exact live-fire repro survives the normalize intact inside a code span', async () => {
    const input = 'path check: `C:\\Users\\cody\\cortextos\\tools\\test` should stay literal';
    await busCommand.parseAsync(['send-mobile-reply', 'test-agent', input], { from: 'user' });

    const entry = readLastOutbound('test-agent');
    expect(entry.text).toBe(input);
    expect(entry.text).not.toContain('\t');
  });

  it('outside a code span, literal \\n still normalizes (regression guard)', async () => {
    await busCommand.parseAsync(['send-mobile-reply', 'test-agent', 'line1\\nline2'], { from: 'user' });
    const entry = readLastOutbound('test-agent');
    expect(entry.text).toBe('line1\nline2');
  });
});
