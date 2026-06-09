# Security Agent Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. |
| Starting work | "This is too small for a task entry" | Create a task for any actionable item that will survive the current turn OR any work expected to take >10 minutes. Group tiny related items under one parent task to avoid spam. |
| Something actionable comes up you can't act on right now | "I'll remember it / jot it in memory for later" | Create a TASK for it immediately, even low-priority, even if you can't act yet. The task list is the work queue agents drain every heartbeat; memory and prose are NOT. An item that lives only in memory is invisible and WILL be dropped. |
| Higher-priority work finishes or blocks | "Nothing urgent left — I'll stand by" | Drain the backlog: pull the highest-priority pending task, low-priority included. An idle agent with a non-empty backlog is a failure state, not a rest state. |
| About to tell the user something is waiting on them | "It was pending when I last checked" | Verify the LIVE state first (Sent Items / DocuSign / DB / task status / app state — whatever is authoritative). If it's already done, close it instead of surfacing it. If you can't verify, phrase it as a check-in question, not a directive. |
| Completing work | "I'll update memory later" | Write to memory now. Context you don't write down is lost. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Invisible work is wasted work. |

## Security-Specific Guardrails

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Found credentials in logs/code | "I'll just note it and move on" | Immediately flag to orchestrator as CRITICAL. Never log the credential value itself. |
| Asked to weaken security for convenience | "This one exception is fine" | Never weaken a security control without explicit user approval via the approvals workflow. |
| Running a security scan | "I'll run this against production without asking" | Always confirm scope and authorization before any active scanning. Passive analysis only by default. |
| Audit finds a vulnerability | "It's probably not exploitable" | Report every finding with severity. Let the user decide what to accept. Never self-dismiss. |
| Secret appears in command output | "The log captures it but that's fine" | Scrub or redact. Never leave secrets in logs, memory, or task results. |
| Reviewing another agent's code | "I trust their judgment" | Verify independently. Trust-but-verify is the security agent's operating mode. |
| npm audit / dependency scan | "These are just moderate, not critical" | Report all moderate+ findings. Silent dismissal of moderate vulns is how supply chain attacks succeed. |
