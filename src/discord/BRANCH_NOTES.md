# Discord Inbound — branch notes (feat/discord-inbound)

Backup two-way comms for the fleet. OUTBOUND already worked (webhook,
`DISCORD_WEBHOOK_URL`, returns 204). This branch adds INBOUND: an
orchestrator-only REST poller that injects Cody's messages into the boss
inbox the same way the Telegram fast-checker does, plus a symmetric
`bus send-discord` verb.

Cody-directed; boss-approved v1 (one bot + one channel → boss). For Sentinel's
audit diff against the locked 6 criteria.

## Files
- `src/discord/api.ts` — REST client. `getMessagesAfter(channelId, afterId)` (Bot-token auth, 15s timeout, snowflake-ascending sort via BigInt) + `postWebhook(url, content)` for outbound (no token; webhook self-auth; 2000-char split).
- `src/discord/gate.ts` — **pure trust boundary** (unit-tested). `parseAllowedDiscordUsers` (fail-closed parse) + `routeDiscordInbound` (author.id-only auth, default-DENY, empty-allowlist drops all).
- `src/discord/poller.ts` — `DiscordPoller`, mirrors `TelegramPoller`. Offset = last snowflake → `.discord-offset`. **Offset-after-handler**: cursor advances only after handlers succeed; a throw re-serves the message next poll.
- `src/discord/format.ts` — `formatDiscordTextMessage`: `=== DISCORD from [USER: ..] (channel:..) ===` + backtick-fenced body (mirrors Telegram; untrusted-inbound handling).
- `src/cli/bus.ts` — `send-discord <message>` command (reads `DISCORD_WEBHOOK_URL` from `orgs/<org>/secrets.env`, logs outbound + emits `discord_sent`).
- `src/daemon/agent-manager.ts` — `maybeStartDiscordInboundPoller` (orchestrator-only, mirrors `maybeStartActivityChannelPoller`); auth gate at ingest → `checker.queueTelegramMessage` (the transport-agnostic sink). + entry-type fields + `stopAgent` cleanup.
- `src/types/index.ts` — `DiscordUser` / `DiscordMessage` (additive).
- Tests: `tests/unit/discord/{gate,poller,send-discord}.test.ts` — 16 tests, all green.

## Mapping to Sentinel's 6 criteria
1. **Auth on author.id only** — `routeDiscordInbound` keys off `msg.author.id` (snowflake string); username/global_name never consulted. Test: "authorizes on author.id ONLY — non-allowed id dropped even if username looks legit".
2. **Hard Cody-only floor in code, at ingest** — the gate runs in `poller.onMessage` BEFORE `queueTelegramMessage`; default-DENY. Allowlist is Cody-first (index 0 preserved).
3. **Inbound = untrusted** — `[USER:]` wrapper + backtick-fenced body; no body inspection for auth. Test: "wraps body as fenced data".
4. **Token in secrets.env only** — `DISCORD_BOT_TOKEN` read from `orgs/<org>/secrets.env` in agent-manager; never logged/echoed (`DiscordAPI` redacts; drop-log carries no token).
5. **Minimal scope (REST)** — bot needs only View Channel + Read Message History on ONE channel; no privileged gateway intents. See empirical note below.
6. **Fail-closed** — token set + `DISCORD_CHANNEL_ID` or `DISCORD_ALLOWED_USER` missing/empty/non-numeric ⇒ poller does NOT start (refuse all inbound). Gate-level: empty allowlist drops every message. Tests: "FAIL-CLOSED: empty allowlist drops every message" + parse returns [] on malformed input.

### Refinements applied
- (a) ONE startup `log()` for config-missing (no per-poll spam); runtime rejects use `discordRejectCount` → SECURITY-notice injection to the orchestrator session after 3 consecutive (30-min cooldown). Alert path is **Telegram-independent by design** (Telegram may be the thing that's down): orchestrator-session injection + daemon log, not a Telegram send. Flag if you want a harder analyst alert.
- (b) `DISCORD_ALLOWED_USER` in secrets.env, mirrors `ALLOWED_USER` (comma-split, numeric-validated, Cody first). Not checked-in config.
- (c) Drop-log = `dropped:<reason> author.id=.. channel=.. message=..` ONLY. Never body, never token, never display name.

## ⚠ EMPIRICAL VERIFICATION — pending live token (criterion 5)
**Claim (endorsed):** REST `GET /channels/{id}/messages` returns `content` via
channel perms (View + Read Message History); the privileged MESSAGE CONTENT
INTENT gates GATEWAY events only, NOT REST. ⇒ zero privileged intents needed.

**Not yet verified live** (no token at build time). When Cody's 3 inputs land
(`DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, Cody's numeric user id):
1. Confirm `getMessagesAfter` returns NON-EMPTY `content` for a Cody post.
2. If empty ⇒ fallback: enable Message Content Intent in the Dev Portal (and note it here). Do NOT add gateway code.
3. Record the result in this section before handing to boss for deploy.

## ⚠ Scope: GUILD channel, not DM
v1 channel MUST be a guild (server) text channel the bot has View + Read
Message History on (that one channel only). Bots cannot REST-poll DM history
the same way. Confirm `DISCORD_CHANNEL_ID` is guild-scoped when Cody supplies it.

## Config (secrets.env, when token lands)
```
DISCORD_WEBHOOK_URL=...        # already set (outbound)
DISCORD_BOT_TOKEN=...          # inbound, bot token
DISCORD_CHANNEL_ID=...         # the one guild channel (numeric)
DISCORD_ALLOWED_USER=...       # Cody's numeric discord user id (Cody first)
```
No code change needed to enable — the poller reads these on next daemon start.

## Test bar (Sentinel) — all green
1. non-allowed author.id ⇒ dropped + 0 inject ✓
2. fail-closed allowlist-unset ⇒ 0 inject ✓
3. offset-after-handler advance ✓
4. dedup precondition (stable formatted ⇒ FastChecker.isDuplicate suppresses) ✓
5. POSITIVE: authorized id normal msg DOES inject ✓
6. crash-safety: handler throw leaves cursor un-advanced + re-polls ✓
