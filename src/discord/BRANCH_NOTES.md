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
- `src/discord/poller.ts` — `DiscordPoller`, mirrors `TelegramPoller`. Offset = last snowflake → `.discord-offset`. **Offset-after-handler**: cursor advances only after handlers succeed; a throw re-serves the message next poll. **First-run seeding** (Sentinel rec i): with no persisted cursor, the first poll seeds to the newest existing message and injects nothing — only post-startup messages inject, so a channel's pre-existing history is never replayed (no stale-command-on-enable).
- `src/discord/format.ts` — `formatDiscordTextMessage`: `=== DISCORD from [USER: ..] (channel:..) ===` + backtick-fenced body (mirrors Telegram; untrusted-inbound handling).
- `src/cli/bus.ts` — `send-discord <message>` command (reads `DISCORD_WEBHOOK_URL` from `orgs/<org>/secrets.env`, logs outbound + emits `discord_sent`).
- `src/daemon/agent-manager.ts` — `maybeStartDiscordInboundPoller` (orchestrator-only, mirrors `maybeStartActivityChannelPoller`); auth gate at ingest → `checker.queueTelegramMessage` (the transport-agnostic sink). + entry-type fields + `stopAgent` cleanup.
- `src/types/index.ts` — `DiscordUser` / `DiscordMessage` (additive).
- Tests: `tests/unit/discord/{gate,poller,send-discord}.test.ts` — 19 tests, all green (incl. 3 first-run-seeding tests — seed-to-newest, empty-then-first, retry-on-error).

## Post-audit hardening (after Sentinel PASS on 821a40a)
- **Rec (i) resolved — first-run backlog seeding.** Added `DiscordPoller.seedOffset`: on initial enable (no `.discord-offset`), the first poll anchors the cursor to the channel's newest existing message and injects NOTHING; only messages posted after startup are processed. Eliminates the "replay pre-existing channel history as new (possibly stale) commands on enable" risk Sentinel flagged. Empty-channel-at-boot still injects the first real message normally. +2 tests.
- Rec (ii) (harder analyst reject-alert) deferred to Sentinel's canary as she offered — v1 keeps orchestrator-session reject-notice.

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

## ✅ EMPIRICAL VERIFICATION — criterion 5 RESOLVED (2026-06-04)
**Original claim (WRONG, was endorsed):** "REST `GET /channels/{id}/messages`
returns `content` via channel perms; MESSAGE CONTENT INTENT gates gateway only,
not REST ⇒ zero privileged intents needed."

**Live result DISPROVED it.** With the intent OFF, REST returned the channel's
10 messages WITH ids/authors/timestamps (View+ReadHistory perms fine) but
`content=""` on ALL — including Cody's own message. Empty-content-with-metadata
= the textbook signature of the intent being OFF. Discord gates `content` in
BOTH gateway AND REST unless the Message Content privileged intent is enabled.
The empirical gate caught the banked-on-assumption before a false bank.

**FALLBACK ENGAGED + VERIFIED.** Cody enabled Message Content Intent (Dev Portal
→ Loftco Agents → Bot → Privileged Gateway Intents → Message Content). NO code
change. Re-run PASS:

ARTIFACT 1 — CONTENT (`getMessagesAfter` on `1512097508866785504`): 9/10 msgs
  non-empty. Cody's own msg `id=1512099108775788554` author.id `697195741294100602`
  content = "Any idea why telegram is down?…" (was `""` pre-intent = true
  before/after). Boss/webhook msgs all read full content.
ARTIFACT 2 — GUILD COUNT (`GET /users/@me/guilds`): exactly 1 — `loftco-autopilot`
  (id `1512097508296364163`).
ARTIFACT 3 — CHANNEL-FENCE MATRIX: only `1512097508866785504` (#loftco-agents)
  READABLE; every other channel 403; `single_readable_channel=True`.

**Posture amend:** we DO need the one privileged intent (Message Content). Still
least-privilege — REST-only, NO gateway, ONE channel. ⚠ Bot rides @everyone
guild-wide VIEW_CHANNEL (fence is discipline-based, not structural) → standing
guardrail: new loftco-autopilot channels must be PRIVATE, or the bot's
content-read silently expands. Robust upgrade (later, verify-with-Cody): a
category-level Loftco-Agents-role deny-VIEW propagates to new synced channels =
by-construction fence, humans unaffected.

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
