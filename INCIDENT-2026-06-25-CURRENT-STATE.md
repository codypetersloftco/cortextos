# INCIDENT 2026-06-25 — LIVE STATE + CLEANUP/RELAUNCH RUNBOOK (for a fresh external Claude CLI)

**Purpose:** The earlier Claude CLI session that ran the recovery was lost (see §"How the CLI session was lost"). This file + `INCIDENT-2026-06-25-dashboard-postcss-forkbomb.md` together give a fresh external session 100% of the prior context plus current live state and a safe relaunch procedure. Read both, then you can help "from the outside" again.

**To resume as an external fixer:** open a new terminal → run `claude` → tell it: "Read `C:\Users\cody\cortextos\INCIDENT-2026-06-25-dashboard-postcss-forkbomb.md` and `C:\Users\cody\cortextos\INCIDENT-2026-06-25-CURRENT-STATE.md`, then help me cleanly relaunch the cortextos system."

---

## Box health (stable as of writing)
- ~15 GB RAM free, no fork-bomb, no crash-loop.
- `postcss.js` worker count = 0 (verified across a guarded build; stayed 0).
- python ~25 (flat, not growing), node ~12.

## What is RUNNING right now (verified)
**Loftco work apps — all UP:**
| App | Frontend (browser) | Backend |
|-----|--------------------|---------|
| AI Admin (invoices/AP) | https://localhost:5173/ (200, "AI Admin") | http://127.0.0.1:8000 (200, /docs 200) — `run.py` |
| Lot Status | https://localhost:5175/ | 127.0.0.1:8002 (uvicorn) |
| FBI (Framing Bid Intelligence) | http://localhost:5174/ | 0.0.0.0:8001 (uvicorn) |

- **Work-app BACKENDS run STANDALONE (not pm2)** — they survived the pm2 God-daemon kill and serve directly. Do NOT assume the apps are "down"; the backends are up.
- **Frontends + ai-admin workers run under pm2** (online, restarts=0): ai-admin-frontend, ai-admin-worker-fast, ai-admin-worker-slow, lot-status-frontend, fbi-frontend, pm2-logrotate. (Vite frontends; ai-admin/lot-status serve **HTTPS**, fbi serves HTTP.)
- **cortextos daemon runs DIRECTLY (PID ~75144), not under pm2.** Works and survives, but no autorestart and won't return after a host reboot. Migrate to pm2 later, carefully (IPC-pipe clash per ecosystem warning).
- **cortextos AGENTS:** boss, analyst, engineer, penny, prism (claude), dbanalyst (gpt-5.5) — all running under the daemon. `cortextos status` to confirm.
- **cortextos DASHBOARD is UP on `next start` at :3000** (manual detached PID ~31860) serving the FIXED build. This is a manual orphan — will NOT survive a host reboot; re-enable under the watchdog when ready (stop the orphan first to free 3000).

## What is FIXED (permanent fix, doc §5 — all DONE + verified)
- **§5.1:** `dashboard/next.config.ts` — Turbopack root pinned to `__dirname` (was `process.cwd()`, which under pm2 resolved to the `cortextos/` parent = the dual-lockfile wrong-root bug → tailwindcss unresolvable → postcss fork-bomb). Added `outputFileTracingRoot: __dirname`.
- **§5.2:** dashboard moved to `next build` + `next start` via the cortextos ecosystem GENERATOR (`cortextos ecosystem --dashboard-mode start`); ecosystem.config.js NOT hand-edited; backup saved.
- **§5.3:** `cd dashboard && npm run build` → "Compiled successfully", 18 routes, ZERO tailwindcss/resolve/OOM errors, postcss stayed 0 the whole build.
- **§5.4:** all-chat hydration bug fixed — was `<button>` nested inside `<button>` (TimeAgo's Radix TooltipTrigger inside the AllChatView row button) in `dashboard/src/components/comms/all-chat-view.tsx`; outer row converted to `<div role="button">` with keyboard handlers; unit tests 2/2 pass; shared TimeAgo untouched.

## PENDING before "re-enable dashboard under watchdog" (gated on Cody go)
1. Stop the manual orphan dashboard (PID ~31860) to free :3000.
2. Bring the dashboard up under the watchdog/generator (next start mode).
3. Confirm postcss stays at 0 and the box stays stable; then return to normal launch.

## SAFE FULL-SYSTEM RELAUNCH ORDER (if a clean restart is needed)
Do these in order; verify each before the next. **Never bulk `pm2 start` — see landmines.**
1. **Inventory first.** `pm2 jlist`, `cortextos status`, and check listeners: ports 8000/8001/8002 (backends), 5173/5174/5175 (frontends), 3000 (dashboard). Find what is ALREADY up before starting anything.
2. **Backends:** if a backend port is already LISTENING, it is already running standalone — leave it. Only start a backend whose port is free, and start that ONE process, not the whole ecosystem.
3. **Frontends/workers (pm2):** start individually by name only if not already online, e.g. `pm2 start <id|name>`. Confirm `restart_time` stays 0 (a climbing count = a port clash = stop immediately).
4. **Daemon + agents:** `cortextos status`; if down, start via the supported cortextos command. (Note current daemon is a direct process, not pm2.)
5. **Dashboard:** ONLY `next build` then `next start` (or the generator's start mode). NEVER `next dev`/`dev:real` until the Turbopack root fix is confirmed present (it is, as of this doc).

## LANDMINES — do NOT repeat
- **Do NOT `pm2 start C:\Users\cody\loftco.ecosystem.config.js`** (or any bulk ecosystem start). The backends already run standalone, so pm2 launches DUPLICATES that crash-loop on EADDRINUSE, and on Windows each retry spawns python via a cmd-shim = a cmd-window storm that steals focus. **This is what killed the prior external CLI session** (see below). Start individual processes only, and only for genuinely-down ports.
- **Do NOT run `next dev` / `npm run dev:real` on the dashboard** unless the Turbopack root fix is present. `dashboard/package.json` `"dev"` is intentionally neutralized (prints disabled + exits); the original lives in `"dev:real"`.
- **Do NOT hot-edit a supervised dev server.** Develop the dashboard in a throwaway local instance, never the pm2/daemon-launched one.
- **Do NOT start a process on a port that is already LISTENING** — on Windows the crash-loop spawns visible console windows (the loftco python apps still lack `windowsHide`; the dashboard side already has it via commit f38f0fe).

## How the CLI session was lost (honest mechanism)
A `pm2 start` of the full loftco ecosystem spawned duplicate backends that crash-looped on already-bound ports (8000/8001/8002). On Windows pm2 launches each python through a cmd shim, so every rapid retry popped a real console window — a focus-stealing spawn storm. The exact path that terminated the external `claude.exe` is not proven (likely the window storm stole focus / buried or disrupted the hosting terminal/conhost; no direct kill signal was sent). Lesson encoded in the landmines above.

## Resolved questions
- ~~Are the pm2 ai-admin workers duplicates (double AP-queue processing)?~~ **RESOLVED (engineer audit, 2026-06-25):** NOT duplicates. Workers are singletons-with-footprint — 1 fast@485MB, 1 slow@472MB, 1 run.py@266MB; the extra small PIDs (0–4MB) are launcher/shim/reaped wrappers, not RAM-ballooning dups. No double-processing risk.

_Maintained by: boss agent. Incident day 2026-06-25._
