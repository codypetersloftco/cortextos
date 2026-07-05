# INCIDENT 2026-06-25 — Dashboard `next dev` postcss fork-bomb crashed the host

**Status:** Stabilized. Root cause identified. One temporary mitigation applied (see §4). Permanent fix still required from you (the agents) — see §5.

**Audience:** cortextos agents (engineer/prism/whoever owns the dashboard). Read this fully before touching the dashboard or running any dev server.

---

## 1. Symptoms

- Host (32 GB RAM) repeatedly crashed: ~2,000 `node.exe` processes, ~45 GB working set, **Windows commit charge pinned at 100%** (111.7/111.7 GB), free RAM <2 GB.
- "Agents weren't responding" — the whole box was starved/thrashing, not an agent logic bug.
- Windows error visible in logs: `OS can't spawn worker thread: The paging file is too small for this operation to complete. (os error 1455)` and `Fatal process out of memory`.

## 2. Root cause (confirmed with live process capture)

The **cortextos-dashboard `next dev` (Turbopack) server spawns unbounded `postcss.js` worker processes** and exhausts host memory.

Live fingerprint captured during the storm (digits normalized):
```
474×  "node" C:\Users\cody\cortextos\dashboard\.next\dev\build\postcss.js
      npm run dev  ->  next dev  ->  next/dist/server/lib/start-server.js
      (one parent PID held 657 children)
```

**Why postcss loops:** Next.js infers the Turbopack **workspace root as `C:\Users\cody\cortextos`** (the parent) instead of `C:\Users\cody\cortextos\dashboard`, because **two lockfiles exist** (`cortextos\package-lock.json` AND `dashboard\package-lock.json`). With the wrong root, Turbopack **cannot resolve `tailwindcss`**:
```
Error: Can't resolve 'tailwindcss' in 'C:\Users\cody\cortextos'
```
(`tailwindcss` and `@tailwindcss/postcss` ARE installed — in `dashboard\node_modules` — so this is purely a root-resolution bug, not a missing dep.) Each failed compile spawns a postcss worker that isn't reaped; `next dev` recompiles on every file save / HMR tick; the agent was **live-editing dashboard files** (the comms "All Chat" + typing work + `next.config.ts`), so saves + the failing build multiplied workers faster than they exited → fork-bomb → OOM.

**Key point:** This is NOT an agent-logic bug and NOT the daemon. It triggers because an agent runs `npm run dev &` on the dashboard (the onboarding convention) while the build config is broken. The daemon/agents and the dashboard are separate processes; the agents do not import the dashboard code.

## 3. Evidence sources
- `C:\Users\cody\.pm2\logs\cortextos-dashboard-error.log` — `Can't resolve 'tailwindcss'`, repeated `Found a change in next.config.ts. Restarting the server...`, Turbopack OOM panics.
- Live `Win32_Process` capture of the storm (the 474× postcss fingerprint above).
- `dashboard\package.json` — `tailwindcss`/`@tailwindcss/postcss` present in devDependencies.

## 4. Temporary mitigation already applied (do not undo until §5 is done)

`dashboard\package.json` `dev` script was **neutralized** so an accidental `npm run dev` can't fork-bomb the host again:
- `"dev"` → prints a disabled message and exits (no server).
- `"dev:real": "next dev"` → the original command, **do NOT run until the fix in §5 is in place**.

Nothing else in the dashboard was changed. The All Chat / typing feature files were **left intact on purpose** so you can finish/clean them up.

## 5. Permanent fix YOU must apply (then verify)

1. **Pin the Turbopack workspace root** so postcss resolves `tailwindcss` from `dashboard\node_modules`. In `dashboard\next.config.ts`:
   ```ts
   import path from 'node:path';
   const nextConfig = {
     turbopack: { root: __dirname },        // or path.resolve(__dirname)
     outputFileTracingRoot: __dirname,
     // ...existing config
   };
   ```
   (Alternatively/additionally, eliminate the dual-lockfile ambiguity — but `cortextos\package-lock.json` is legitimately needed by the framework, so prefer pinning the root over deleting lockfiles.)

2. **Stop running the dashboard as `next dev` under supervision.** Use `next build` + `next start` for the long-running instance. `next dev` + file-watching + an agent editing = recompile storms. The pm2 ecosystem entry currently uses `args: "dev"` — but `ecosystem.config.js` is AUTO-GENERATED (`// Do NOT edit by hand. Re-run cortextos ecosystem`), so change the generator/run-mode the supported way, not by hand-editing the file.

3. **Verify before declaring fixed** — do this on a guarded run, watching process count:
   - `cd dashboard && npm run build` → must complete with **no** `Can't resolve 'tailwindcss'` and a bounded, finite number of postcss processes.
   - Only then restore `"dev"` from `"dev:real"` if you truly need dev mode, and confirm `postcss.js` process count stays in the single digits while editing.

4. **Fix the All Chat UI bug** you were mid-change on: the dashboard error log shows a hydration error — **`<button>` nested inside `<button>`** (a `TooltipTrigger` button rendered inside the AllChatView row `<button>` in `components/comms/all-chat-view.tsx`). Also clean up the `Unsupported metadata viewport` warnings if in scope.

## 6. Guardrails going forward
- **Never** run `next dev` / `npm run dev:real` on the dashboard until §5.1 is in place and verified.
- **Do not hot-edit a supervised dev server.** Develop the dashboard in a throwaway local instance, not the pm2/daemon-launched one.
- Watch `postcss.js` process count when touching the dashboard; if it climbs past ~10, stop — the root config is still wrong.

## 7. Current host state at time of writing
- Storm stopped; ~24 GB free; spawn chain dead.
- `cortextos-daemon` + agents being brought back up (dashboard dev neutralized so it's safe).
- pm2 God daemon was killed during stabilization; the loftco work apps (ai-admin/lot-status/fbi) and the dashboard are currently **down** and need a clean restart once you confirm §5.
