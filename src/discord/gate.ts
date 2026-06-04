/**
 * Discord inbound trust boundary — pure, directly-testable.
 *
 * Sentinel inbound-security audit (build-to-letter). Keeping the authorization
 * decision in a pure function (not buried in daemon wiring) makes the trust
 * boundary unit-testable: the audit's verify-bar tests target THIS file.
 *
 *   1) AUTH on author.id (snowflake) ONLY — never username/global_name.
 *   2) HARD Cody-only floor: default-DENY; only ids in the allowlist pass.
 *   3) Inbound body is UNTRUSTED — formatDiscordTextMessage wraps it.
 *   6) FAIL-CLOSED: an EMPTY allowlist drops everything (refuse all inbound).
 */
import { formatDiscordTextMessage } from './format.js';
import type { DiscordMessage } from '../types/index.js';

/**
 * Parse DISCORD_ALLOWED_USER. Comma-split, numeric-validated, ORDER PRESERVED
 * (Cody FIRST = the hard floor — index 0 stays the canonical id for any future
 * button/approval gate). Returns [] when missing / empty / ANY token non-numeric
 * — an empty result is the FAIL-CLOSED signal: the caller must refuse all
 * inbound (never fail open on a malformed allowlist).
 */
export function parseAllowedDiscordUsers(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => /^\d+$/.test(id))) return [];
  return ids;
}

export type DiscordDropReason = 'unauthorized' | 'empty-author';

export interface DiscordRouteResult {
  /** True only when the message is authorized and may be injected. */
  inject: boolean;
  /** The author snowflake (empty string if the message had none). */
  authorId: string;
  /** The PTY-injection block — present iff inject === true. */
  formatted?: string;
  /** Why a message was dropped — present iff inject === false. */
  reason?: DiscordDropReason;
}

/**
 * Decide whether an inbound Discord message may be injected into the agent.
 *
 * The trust boundary: authorize on `msg.author.id` ONLY, default-DENY. An
 * empty `allowedIds` set drops everything (fail-closed). The body is never
 * inspected for authorization — it is untrusted data and only ever reaches
 * the agent wrapped by formatDiscordTextMessage.
 *
 * @param stripText caller's control-char stripper (kept injectable so this
 *   stays a pure function with no import of the daemon's validate util).
 */
export function routeDiscordInbound(
  msg: DiscordMessage,
  allowedIds: ReadonlySet<string>,
  channelId: string,
  stripText: (s: string) => string = (s) => s,
): DiscordRouteResult {
  const authorId = typeof msg.author?.id === 'string' ? msg.author.id : '';
  if (!authorId) return { inject: false, authorId: '', reason: 'empty-author' };
  if (!allowedIds.has(authorId)) return { inject: false, authorId, reason: 'unauthorized' };

  // Authorized. Display name is cosmetic; the [USER:] wrapper + fenced body in
  // formatDiscordTextMessage neutralize prompt-injection via crafted content.
  const from = stripText(msg.author?.username || 'cody');
  const text = stripText(msg.content || '');
  return { inject: true, authorId, formatted: formatDiscordTextMessage(from, channelId, text) };
}
