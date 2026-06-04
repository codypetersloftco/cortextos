/**
 * Minimal Discord REST client for the inbound poller and outbound webhook.
 *
 * Design constraints (Sentinel inbound-security audit, criterion 5 — minimal scope):
 *   - REST only. The bot needs ONLY "View Channel" + "Read Message History"
 *     on ONE dedicated channel. No all-guild read, NO privileged gateway
 *     intents. The privileged MESSAGE CONTENT INTENT gates GATEWAY events,
 *     NOT REST channel reads — GET /channels/{id}/messages returns `content`
 *     via the channel permissions alone. (Verified empirically in the branch
 *     notes; if a future Discord change ever strips REST content the fallback
 *     is to enable the intent.)
 *   - The bot token is read from secrets.env (DISCORD_BOT_TOKEN) by the
 *     caller and passed in. This class NEVER logs it.
 *
 * Mirrors the shape of src/telegram/api.ts (constructor takes the token,
 * builds a base URL, single private POST/GET with a 15s timeout and uniform
 * error wrapping) so the two transports stay structurally parallel.
 */

import type { DiscordMessage } from '../types/index.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class DiscordAPI {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Fetch messages in a channel newer than `afterId` (a snowflake string),
   * returned sorted ASCENDING by snowflake (oldest-first) so the poller can
   * process them in chronological order and advance its offset monotonically.
   *
   * Discord returns up to `limit` messages in DESCENDING order; we re-sort.
   * Snowflakes exceed Number.MAX_SAFE_INTEGER, so comparison uses BigInt.
   *
   * `afterId` of '0' (or empty) means "from the start the bot can see"; we
   * pass no `after` param in that case and Discord returns the most recent
   * `limit`, which we still sort ascending.
   */
  async getMessagesAfter(channelId: string, afterId: string, limit = 100): Promise<DiscordMessage[]> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(Math.max(limit, 1), 100)));
    if (afterId && afterId !== '0') params.set('after', afterId);
    const path = `/channels/${channelId}/messages?${params.toString()}`;
    const raw = await this.get(path);
    const arr: DiscordMessage[] = Array.isArray(raw) ? raw : [];
    return arr.sort((a, b) => {
      const da = BigInt(a.id);
      const db = BigInt(b.id);
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }

  /**
   * GET helper. Authenticates with the bot token, 15s timeout, uniform error
   * wrapping. Never includes the token in thrown messages.
   */
  private async get(path: string): Promise<unknown> {
    try {
      const response = await fetch(`${DISCORD_API_BASE}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        // Redact: never echo the token; body is Discord's error JSON (safe).
        throw new Error(`Discord API error ${response.status}: ${body.slice(0, 200)}`);
      }
      return await response.json();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Discord API error')) throw err;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Discord API request timed out after 15s: GET ${path.split('?')[0]}`);
      }
      throw new Error(`Discord API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Outbound: post a message to a Discord channel via an incoming webhook URL.
 * This is the proven outbound path (DISCORD_WEBHOOK_URL in secrets.env,
 * returns 204) and requires NO bot token — webhooks are self-authenticating.
 *
 * Discord webhook content cap is 2000 chars; we split on paragraph/line
 * boundaries to stay under it (mirrors Telegram's splitHtml behaviour).
 * Returns the number of chunks posted.
 */
export async function postWebhook(webhookUrl: string, content: string): Promise<number> {
  const chunks = splitForDiscord(content, 1900);
  for (const chunk of chunks) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk }),
      signal: AbortSignal.timeout(15000),
    });
    // Webhook success is 204 No Content (or 200 with ?wait=true).
    if (response.status !== 204 && response.status !== 200) {
      const body = await response.text().catch(() => '');
      throw new Error(`Discord webhook error ${response.status}: ${body.slice(0, 200)}`);
    }
  }
  return chunks.length;
}

/**
 * Split text into <= maxLen chunks, preferring paragraph then line then hard
 * boundaries so we never exceed Discord's 2000-char message limit.
 */
function splitForDiscord(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
