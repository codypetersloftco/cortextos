import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiscordPoller } from '../../../src/discord/poller';
import type { DiscordAPI } from '../../../src/discord/api';
import type { DiscordMessage } from '../../../src/types/index';

function msg(id: string, content = 'hi'): DiscordMessage {
  return { id, channel_id: '999', author: { id: '724702591', username: 'cody' }, content };
}

/**
 * Stub DiscordAPI that serves a fixed set of messages, returning only those
 * with snowflake > afterId (BigInt-compared), ascending — matching the real
 * getMessagesAfter contract the poller relies on.
 */
function makeStubApi(all: DiscordMessage[]): { api: DiscordAPI; calls: string[] } {
  const calls: string[] = [];
  const api = {
    getMessagesAfter: vi.fn(async (_channelId: string, afterId: string) => {
      calls.push(afterId);
      return all
        .filter((m) => BigInt(m.id) > BigInt(afterId || '0'))
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    }),
  } as unknown as DiscordAPI;
  return { api, calls };
}

describe('DiscordPoller — offset-after-handler crash-safety', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cortextos-discord-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  // (3) offset advances only after the handler succeeds, persisted to .discord-offset
  it('advances + persists the cursor to the last processed snowflake', async () => {
    const { api } = makeStubApi([msg('100'), msg('101'), msg('102')]);
    const poller = new DiscordPoller(api, '999', stateDir);
    const seen: string[] = [];
    poller.onMessage((m) => { seen.push(m.id); });

    await poller.pollOnce();

    expect(seen).toEqual(['100', '101', '102']);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('102');
  });

  // (6) crash-safety: a handler throw leaves the cursor at the LAST good message,
  // and the failed message is RE-SERVED on the next poll (never silently dropped).
  it('does NOT advance past a message whose handler throws; re-serves it next poll', async () => {
    const { api } = makeStubApi([msg('200'), msg('201'), msg('202')]);
    const poller = new DiscordPoller(api, '999', stateDir);
    let failOn201 = true;
    const delivered: string[] = [];
    poller.onMessage((m) => {
      if (m.id === '201' && failOn201) throw new Error('sink down');
      delivered.push(m.id);
    });

    // First poll: 200 processes, 201 throws -> cursor stays at 200, 202 deferred.
    await poller.pollOnce();
    expect(delivered).toEqual(['200']);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('200');

    // Recover the sink; next poll re-serves 201 (and 202) — nothing dropped.
    failOn201 = false;
    await poller.pollOnce();
    expect(delivered).toEqual(['200', '201', '202']);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('202');
  });

  it('persists and reloads a snowflake-string offset across instances', async () => {
    const { api } = makeStubApi([msg('300')]);
    const p1 = new DiscordPoller(api, '999', stateDir);
    p1.onMessage(() => {});
    await p1.pollOnce();
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('300');

    // A fresh poller in the same stateDir resumes from the persisted cursor —
    // so already-seen messages are not re-polled.
    const { api: api2, calls } = makeStubApi([msg('300')]);
    const p2 = new DiscordPoller(api2, '999', stateDir);
    p2.onMessage(() => {});
    await p2.pollOnce();
    expect(calls[0]).toBe('300'); // resumed from persisted offset, not '0'
  });

  it('no-ops on an empty channel without advancing the cursor', async () => {
    const { api } = makeStubApi([]);
    const poller = new DiscordPoller(api, '999', stateDir);
    poller.onMessage(() => { throw new Error('should not be called'); });
    await poller.pollOnce();
    expect(existsSync(join(stateDir, '.discord-offset'))).toBe(false);
  });
});
