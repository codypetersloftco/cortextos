import { sanitizeForPtyInjection, wrapFenceSafe } from '../utils/validate.js';

/**
 * Format an inbound Discord message into the PTY-injection block.
 *
 * Deliberately mirrors FastChecker.formatTelegramTextMessage so inbound
 * Discord surfaces to the agent in the same shape as Telegram, AND with the
 * SAME PTY-injection hardening:
 *   - `=== DISCORD from [USER: <name>] (channel:<id>) ===` header. The display
 *     name is run through sanitizeForPtyInjection so a crafted name cannot
 *     smuggle a forged `=== AGENT MESSAGE/TELEGRAM` header or `Reply using:`
 *     directive onto its own line (Sentinel criterion 3: untrusted inbound).
 *   - The non-slash body is wrapped with wrapFenceSafe — a DYNAMICALLY-sized
 *     backtick fence (longest inner run + 1). A fixed ``` fence could be
 *     closed early by a body containing its own ``` run, escaping forged
 *     content; the dynamic fence is unescapable. The body is DATA, never
 *     instructions. Authorization was already decided upstream by the
 *     author.id gate at ingest (criterion 2).
 *   - Slash commands (text starting with /) are NOT fenced so Claude Code can
 *     recognize and invoke them via the Skill tool (matches Telegram); they
 *     are still sanitizeForPtyInjection'd so an unfenced slash body cannot
 *     forge a header.
 *   - The "Reply using:" line points at the symmetric `bus send-discord`
 *     verb (single channel == single webhook, so no channel arg needed).
 *
 * NOTE: mirrors the upstream Telegram-sink hardening (#592/#596/#604). Both
 * sanitizeForPtyInjection and wrapFenceSafe stripControlChars internally, so
 * this also subsumes any caller-side control-char strip.
 */
export function formatDiscordTextMessage(
  from: string,
  channelId: string,
  text: string,
): string {
  const safeFrom = sanitizeForPtyInjection(from);
  const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
  const body = isSlashCommand ? sanitizeForPtyInjection(text).trim() : wrapFenceSafe(text);
  return `=== DISCORD from [USER: ${safeFrom}] (channel:${channelId}) ===
${body}
Reply using: cortextos bus send-discord '<your reply>'

`;
}
