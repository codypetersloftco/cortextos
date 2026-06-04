/**
 * Format an inbound Discord message into the PTY-injection block.
 *
 * Deliberately mirrors FastChecker.formatTelegramTextMessage so inbound
 * Discord surfaces to the agent in the same shape as Telegram:
 *   - `=== DISCORD from [USER: <name>] (channel:<id>) ===` header. The
 *     [USER: ...] wrapper + backtick-fenced body is the untrusted-inbound
 *     handling (Sentinel criterion 3): the message body is DATA, never
 *     instructions, and a crafted display name cannot break out of the
 *     wrapper to inject a prompt. Authorization was already decided upstream
 *     by the author.id gate at ingest (criterion 2) — this formatter only
 *     ever sees messages from an authorized id.
 *   - Slash commands (text starting with /) are NOT fenced so Claude Code
 *     can recognize and invoke them via the Skill tool (matches Telegram).
 *   - The "Reply using:" line points at the symmetric `bus send-discord`
 *     verb (single channel == single webhook, so no channel arg needed).
 */
export function formatDiscordTextMessage(
  from: string,
  channelId: string,
  text: string,
): string {
  const isSlashCommand = /^\/[a-zA-Z]/.test(text.trim());
  const body = isSlashCommand ? text.trim() : `\`\`\`\n${text}\n\`\`\``;
  return `=== DISCORD from [USER: ${from}] (channel:${channelId}) ===
${body}
Reply using: cortextos bus send-discord '<your reply>'

`;
}
