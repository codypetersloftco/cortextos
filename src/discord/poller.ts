import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DiscordMessage } from '../types/index.js';
import type { DiscordAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type DiscordMessageHandler = (msg: DiscordMessage) => void;

/**
 * Discord inbound polling loop. The REST-poll analogue of TelegramPoller:
 * polls GET /channels/{id}/messages?after=<cursor> on an interval and routes
 * new messages to registered handlers.
 *
 * Mirrors TelegramPoller deliberately (one mental model for the security
 * audit, no regression risk to the proven path):
 *   - The offset cursor is the last fully-processed message SNOWFLAKE (a
 *     string, since snowflakes exceed Number.MAX_SAFE_INTEGER), persisted to
 *     `.discord-offset` in stateDir — the analogue of `.telegram-offset`.
 *   - OFFSET-AFTER-HANDLER (crash-safety, Sentinel verify-bar #6): the cursor
 *     advances ONLY after every registered handler for a message returns
 *     successfully. If a handler throws, the cursor is left un-advanced — the
 *     message is re-served on the next poll rather than silently dropped, and
 *     the rest of the batch is deferred to preserve chronological order. A
 *     dropped inbound during a Telegram outage is the exact silent-failure
 *     class this backstop guards against.
 */
export class DiscordPoller {
  private api: DiscordAPI;
  private channelId: string;
  private offset: string = '0';
  private running: boolean = false;
  private stateDir: string;
  private offsetFileName: string;
  private messageHandlers: DiscordMessageHandler[] = [];
  private pollInterval: number;
  private log: (msg: string) => void;
  /**
   * True once the cursor is anchored — either loaded from a persisted
   * `.discord-offset` OR seeded on first run. Until then, the first poll
   * SEEDS to the newest existing message (seedOffset) rather than processing
   * backlog — so initial enable never replays a channel's pre-existing
   * history as new (a stale authorized message could otherwise fire as a
   * command). Only messages posted AFTER startup inject. (Sentinel audit rec i.)
   */
  private seeded: boolean = false;

  /**
   * Why the poll loop last exited (read by a supervisor if one is wired):
   *   - 'stopped-externally': intentional stop().
   *   - '' : still running / never exited.
   */
  lastExitReason: string = '';

  constructor(
    api: DiscordAPI,
    channelId: string,
    stateDir: string,
    pollInterval: number = 2000,
    log?: (msg: string) => void,
  ) {
    this.api = api;
    this.channelId = channelId;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = '.discord-offset';
    this.log = log || (() => {});
    this.loadOffset();
  }

  onMessage(handler: DiscordMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        // Transient (rate-limit, network, 5xx) — log and keep polling. The
        // offset only advanced for messages whose handlers succeeded, so
        // nothing is lost on a mid-batch error.
        console.error('[discord-poller] Poll error:', err instanceof Error ? err.message : err);
      }
      await sleep(this.pollInterval);
    }
  }

  stop(): void {
    this.running = false;
    this.lastExitReason = 'stopped-externally';
  }

  /**
   * One poll cycle. Fetches messages after the cursor (ascending), runs each
   * through every handler, and advances + persists the cursor only after a
   * message's handlers all succeed. A handler throw stops the batch with the
   * cursor at the last fully-processed message.
   */
  async pollOnce(): Promise<void> {
    // First run with no persisted cursor: seed to the newest existing message
    // and inject NOTHING this cycle. Only messages posted after startup will
    // be processed — never the pre-existing backlog. Seeding only commits
    // (this.seeded = true) when the anchor was actually determined; a transient
    // fetch error returns false so we RETRY the seed next cycle rather than
    // fall through and replay the backlog from offset 0.
    if (!this.seeded) {
      this.seeded = await this.seedOffset();
      return;
    }

    const messages = await this.api.getMessagesAfter(this.channelId, this.offset, 100);
    if (!messages.length) return;

    for (const msg of messages) {
      let handlerFailed = false;
      for (const handler of this.messageHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error('[discord-poller] Message handler error:', err instanceof Error ? err.message : err);
          handlerFailed = true;
          break;
        }
      }
      if (handlerFailed) {
        // Leave cursor un-advanced → Discord re-serves this message next poll.
        // Defer the rest of the batch to preserve chronological order.
        return;
      }
      this.offset = msg.id;
      this.saveOffset();
    }
  }

  /**
   * Seed the cursor to the channel's newest existing message WITHOUT injecting
   * it — run once on first enable when no `.discord-offset` is persisted. Fetch
   * the single most-recent message (limit 1, no `after`) and anchor the cursor
   * there. An empty channel is a valid anchor (cursor stays '0'; the first
   * message posted afterward injects normally).
   *
   * Returns true when the anchor was successfully determined (got a message OR
   * confirmed the channel empty) and the caller may commit `seeded`. Returns
   * FALSE only on a fetch error — the caller leaves `seeded` false and retries
   * next poll, so a transient error never falls through to replaying the
   * backlog from offset 0. (Poll-interval gated, so not a tight loop.)
   */
  private async seedOffset(): Promise<boolean> {
    try {
      const recent = await this.api.getMessagesAfter(this.channelId, '0', 1);
      if (recent.length > 0) {
        this.offset = recent[recent.length - 1].id; // newest (ascending sort)
        this.saveOffset();
        this.log(`Discord inbound seeded cursor to newest message ${this.offset} (backlog skipped)`);
      }
      return true; // anchored (message or confirmed-empty) — safe to mark seeded
    } catch (err) {
      // Do NOT mark seeded — retry the seed next cycle rather than fall through
      // and replay backlog from offset 0 on a transient error.
      this.log(`Discord inbound seed deferred (fetch error, will retry): ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (existsSync(offsetFile)) {
        const content = readFileSync(offsetFile, 'utf-8').trim();
        // Snowflakes are decimal digit strings; reject anything else. A valid
        // persisted cursor means we're already anchored — skip first-run seeding.
        if (/^\d+$/.test(content)) {
          this.offset = content;
          this.seeded = true;
        }
      }
    } catch {
      // Start from '0' if unreadable.
    }
  }

  private saveOffset(): void {
    ensureDir(this.stateDir);
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      writeFileSync(offsetFile, this.offset, 'utf-8');
    } catch {
      // Ignore write errors — next successful save re-syncs.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
