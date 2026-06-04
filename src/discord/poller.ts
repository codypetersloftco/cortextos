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

  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (existsSync(offsetFile)) {
        const content = readFileSync(offsetFile, 'utf-8').trim();
        // Snowflakes are decimal digit strings; reject anything else.
        if (/^\d+$/.test(content)) this.offset = content;
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
