import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DiscordMessage } from '../types/index.js';
import type { DiscordAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type DiscordMessageHandler = (msg: DiscordMessage) => void;

/**
 * Degraded-state event emitted by the failure watchdog (prism red-team item 5).
 *   - 'auth':      HTTP 401/403 — will NOT self-heal (revoked token, perms
 *                  change). Emitted on the FIRST occurrence.
 *   - 'transient': timeout/429/5xx/network — emitted after
 *                  TRANSIENT_ALERT_THRESHOLD consecutive failures.
 *   - 'recovered': first successful poll after any degraded event fired.
 * Re-alerts are debounced (REALERT_DEBOUNCE_MS). The poller stays
 * transport-agnostic: it only invokes the callback — the caller
 * (agent-manager) owns how the alert is surfaced.
 */
export interface DiscordPollerDegradedEvent {
  kind: 'auth' | 'transient' | 'recovered';
  status?: number;
  consecutiveErrors: number;
  message: string;
}
export type DiscordDegradedHandler = (ev: DiscordPollerDegradedEvent) => void;

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
  private consecutivePollErrors: number = 0;
  private log: (msg: string) => void;
  // ---- failure watchdog state ----
  private degradedHandler: DiscordDegradedHandler | null = null;
  private lastDegradedAlertAt: number = 0;
  /** True once a degraded event fired and no success has happened since. */
  private degradedAlertFired: boolean = false;
  private lastSuccessAt: number = 0;
  private lastErrorAt: number = 0;
  private lastErrorStatus: number | null = null;
  private lastHealthWriteAt: number = 0;
  /** Transient failures alert only after this many CONSECUTIVE errors
   *  (~minutes of real outage at capped backoff). Auth (401/403) alerts on
   *  the first — it will not self-heal. */
  private static readonly TRANSIENT_ALERT_THRESHOLD = 10;
  private static readonly REALERT_DEBOUNCE_MS = 60 * 60 * 1000;
  /** Steady-state health-file refresh cadence (avoid a write per 2s poll). */
  private static readonly HEALTH_WRITE_INTERVAL_MS = 60 * 1000;
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

  onDegraded(handler: DiscordDegradedHandler): void {
    this.degradedHandler = handler;
  }

  async start(): Promise<void> {
    this.running = true;
    this.lastExitReason = '';
    while (this.running) {
      try {
        await this.pollOnce();
        this.handlePollSuccess();
      } catch (err) {
        // Transient (rate-limit, network, 5xx) — log and keep polling. The
        // offset only advanced for messages whose handlers succeeded, so
        // nothing is lost on a mid-batch error.
        //
        // OOM-hardening (Wave 1): on a sustained outage (Discord 503/timeout
        // storm) the bare pollInterval hammered the API every cycle and
        // flooded the daemon log (the 2026-06-05 incident log was mostly
        // poller-timeout spam). Back off exponentially on consecutive errors
        // (capped at 60s) and reset to the normal cadence on the first
        // success, so a healthy channel is unaffected.
        //
        // Failure watchdog (prism red-team item 5): backoff alone retries a
        // revoked token / dead perms FOREVER silently. Classify and emit a
        // degraded event so the wiring layer can alert — polling continues
        // at max backoff either way, so a server-side fix self-recovers.
        this.consecutivePollErrors++;
        console.error('[discord-poller] Poll error:', err instanceof Error ? err.message : err);
        this.handlePollError(err);
        const backoff = Math.min(
          60000,
          this.pollInterval * Math.pow(2, Math.min(this.consecutivePollErrors, 5)),
        );
        await sleep(backoff);
        continue;
      }
      await sleep(this.pollInterval);
    }
  }

  /** Success bookkeeping: recovery notice (only if a degraded event fired),
   *  counter reset, throttled health refresh. */
  private handlePollSuccess(): void {
    const wasErrored = this.consecutivePollErrors > 0;
    this.consecutivePollErrors = 0;
    this.lastSuccessAt = Date.now();
    if (this.degradedAlertFired) {
      this.degradedAlertFired = false;
      this.lastDegradedAlertAt = 0;
      this.degradedHandler?.({
        kind: 'recovered',
        consecutiveErrors: 0,
        message: 'poll succeeded after degraded state',
      });
    }
    if (wasErrored || Date.now() - this.lastHealthWriteAt > DiscordPoller.HEALTH_WRITE_INTERVAL_MS) {
      this.writeHealth();
    }
  }

  /** Error classification + degraded-event emission (debounced). */
  private handlePollError(err: unknown): void {
    const status = typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : undefined;
    const isAuth = status === 401 || status === 403;
    this.lastErrorAt = Date.now();
    this.lastErrorStatus = status ?? null;

    if (
      this.degradedHandler &&
      (isAuth || this.consecutivePollErrors >= DiscordPoller.TRANSIENT_ALERT_THRESHOLD)
    ) {
      const now = Date.now();
      if (now - this.lastDegradedAlertAt > DiscordPoller.REALERT_DEBOUNCE_MS) {
        this.lastDegradedAlertAt = now;
        this.degradedAlertFired = true;
        this.degradedHandler({
          kind: isAuth ? 'auth' : 'transient',
          status,
          consecutiveErrors: this.consecutivePollErrors,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.writeHealth();
  }

  /**
   * Persist `.discord-poller-health` next to `.discord-offset` so the analyst
   * canary can assert poller health without log parsing. Written on every
   * error cycle (backoff-gated) and at most once per minute when healthy.
   */
  private writeHealth(): void {
    try {
      ensureDir(this.stateDir);
      const health = {
        consecutive_poll_errors: this.consecutivePollErrors,
        last_success_at: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
        last_error_at: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
        last_error_status: this.lastErrorStatus,
        degraded_alert_fired: this.degradedAlertFired,
        updated_at: new Date().toISOString(),
      };
      writeFileSync(join(this.stateDir, '.discord-poller-health'), JSON.stringify(health), 'utf-8');
      this.lastHealthWriteAt = Date.now();
    } catch {
      // Health is observability only — never break the poll loop on it.
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
