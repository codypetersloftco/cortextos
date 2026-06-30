# Heartbeat Checklist — EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:
```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes.
Target: 0 un-ACK'd messages after this step.

## Step 3: Check task queue

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- Pending tasks: pick the highest priority one and start it — this INCLUDES low-priority, no-blocker items. "Low priority" means do it *after* higher-priority work, NOT skip it indefinitely.
- In-progress tasks older than 2 hours: complete them or update status with a note
- If your own queue is empty: run a global backlog check scoped to your lane — `cortextos bus list-tasks --status pending` (no `--agent` filter) — and claim anything that matches your lane. Then check GOALS.md for objectives, and ask the orchestrator for unassigned backlog before going idle. Claim or generate a task if there is work to do.

**Backlog-drain rule — never idle with work waiting.** Completing or blocking your higher-priority work is a signal to pull the next item DOWN the list, not a reason to stop. An idle agent with a non-empty backlog is a FAILURE STATE, not a rest state. Only report "standing by" when the backlog is genuinely empty.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
mkdir -p memory
cat >> "memory/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M)
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Re-index memory to KB

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

## Step 7: Check GOALS.md

Read GOALS.md for any new objectives. If goals changed, create tasks:
```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME
```

## Step 8: Resume work

Pick your highest priority task and work on it.

```bash
cortextos bus update-task "<task_id>" in_progress
# ... do the work ...
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
