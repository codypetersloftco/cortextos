import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
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
 * with snowflake > afterId (BigInt-compared), ascending. With afterId '0' the
 * real client passes no `after` and Discord returns the most-recent `limit`
 * newest-first; the stub honors `limit` by returning the newest `limit` so the
 * seed path (limit 1 => newest message) is exercised correctly.
 */
function makeStubApi(all: DiscordMessage[]): { api: DiscordAPI; calls: string[] } {
  const calls: string[] = [];
  const api = {
    getMessagesAfter: vi.fn(async (_channelId: string, afterId: string, limit = 100) => {
      calls.push(afterId);
      const asc = [...all].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (!afterId || afterId === '0') {
        // No `after`: Discord returns the newest `limit`, we return them ascending.
        return asc.slice(Math.max(0, asc.length - limit));
      }
      return asc.filter((m) => BigInt(m.id) > BigInt(afterId)).slice(0, limit);
    }),
  } as unknown as DiscordAPI;
  return { api, calls };
}

/** Mark a poller as already-anchored (write a persisted cursor) so a test can
 *  exercise steady-state processing without the first-run seed cycle. */
function preSeed(stateDir: string, offset = '0'): void {
  writeFileSync(join(stateDir, '.discord-offset'), offset, 'utf-8');
}

describe('DiscordPoller — offset-after-handler crash-safety', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cortextos-discord-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  // (3) offset advances only after the handler succeeds, persisted to .discord-offset
  it('advances + persists the cursor to the last processed snowflake', async () => {
    preSeed(stateDir, '0'); // anchored at 0 => process everything newer
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
    preSeed(stateDir, '0');
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
    preSeed(stateDir, '0');
    const { api } = makeStubApi([msg('300')]);
    const p1 = new DiscordPoller(api, '999', stateDir);
    p1.onMessage(() => {});
    await p1.pollOnce();
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('300');

    // A fresh poller in the same stateDir resumes from the persisted cursor —
    // already-seen messages are not re-polled (and it does NOT re-seed).
    const { api: api2, calls } = makeStubApi([msg('300')]);
    const p2 = new DiscordPoller(api2, '999', stateDir);
    p2.onMessage(() => {});
    await p2.pollOnce();
    expect(calls[0]).toBe('300'); // resumed from persisted offset, not a seed
  });

  it('steady-state poll of an empty channel does not advance the cursor', async () => {
    preSeed(stateDir, '0');
    const { api } = makeStubApi([]);
    const poller = new DiscordPoller(api, '999', stateDir);
    poller.onMessage(() => { throw new Error('should not be called'); });
    await poller.pollOnce();
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('0');
  });
});

describe('DiscordPoller — first-run seeding (no backlog replay)', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'cortextos-discord-seed-')); });
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

  // (Sentinel rec i) On first enable with pre-existing channel history, seed to
  // the newest message and inject NOTHING — only post-startup messages inject.
  it('seeds to the newest existing message and injects nothing on first run', async () => {
    const { api } = makeStubApi([msg('100'), msg('101'), msg('102')]);
    const poller = new DiscordPoller(api, '999', stateDir);
    const seen: string[] = [];
    poller.onMessage((m) => { seen.push(m.id); });

    // First poll = seed cycle: no injection, cursor anchored at newest (102).
    await poller.pollOnce();
    expect(seen).toEqual([]);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('102');

    // A NEW message posted after startup DOES inject.
    api.getMessagesAfter = vi.fn(async (_c: string, afterId: string) =>
      [msg('103')].filter((m) => BigInt(m.id) > BigInt(afterId || '0')));
    await poller.pollOnce();
    expect(seen).toEqual(['103']);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('103');
  });

  it('on an empty channel at first run, seeds to nothing then injects the first real message', async () => {
    const { api } = makeStubApi([]);
    const poller = new DiscordPoller(api, '999', stateDir);
    const seen: string[] = [];
    poller.onMessage((m) => { seen.push(m.id); });

    // First poll: empty channel — seed finds nothing, cursor stays '0', no file.
    await poller.pollOnce();
    expect(seen).toEqual([]);
    expect(existsSync(join(stateDir, '.discord-offset'))).toBe(false);

    // First message ever posted injects normally (not treated as backlog).
    api.getMessagesAfter = vi.fn(async (_c: string, afterId: string) =>
      [msg('500')].filter((m) => BigInt(m.id) > BigInt(afterId || '0')));
    await poller.pollOnce();
    expect(seen).toEqual(['500']);
  });

  // A transient fetch error during the seed must NOT fall through to replaying
  // backlog — seeding retries next poll until it succeeds.
  it('retries seeding on a transient fetch error (never replays backlog from 0)', async () => {
    const seen: string[] = [];
    let failSeed = true;
    const api = {
      getMessagesAfter: vi.fn(async (_c: string, afterId: string) => {
        if (failSeed && (!afterId || afterId === '0')) throw new Error('discord 503');
        return [msg('700')].filter((m) => BigInt(m.id) > BigInt(afterId || '0'));
      }),
    } as unknown as DiscordAPI;
    const poller = new DiscordPoller(api, '999', stateDir);
    poller.onMessage((m) => { seen.push(m.id); });

    // First poll: seed fetch throws -> NOT seeded, nothing injected, no cursor file.
    await poller.pollOnce();
    expect(seen).toEqual([]);
    expect(existsSync(join(stateDir, '.discord-offset'))).toBe(false);

    // Recover: next poll seeds to newest (700) and injects nothing — backlog
    // was never replayed despite the earlier error.
    failSeed = false;
    await poller.pollOnce();
    expect(seen).toEqual([]);
    expect(readFileSync(join(stateDir, '.discord-offset'), 'utf-8').trim()).toBe('700');
  });
});
