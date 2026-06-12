"""
Live inbound Telegram poller for mid-loop steering (the cooperative "soft interrupt").

WHY THIS EXISTS
---------------
The daemon appends every inbound Telegram message to a per-agent live feed the
INSTANT it arrives, independent of the agent's turn:

    <CTX_ROOT>/logs/<agent>/inbound-messages.jsonl

The bus inbox and PTY turn-boundary injection only surface messages at a turn
boundary -- they are empty mid-turn by construction. So during a long multi-pass
loop, an agent that only checks the inbox cannot see Cody steering it until the
loop ends. This script reads the live JSONL feed directly so loop checkpoints can
react to a correction WITHOUT waiting for a new turn or a restart.

DESIGN (matches the boss 4-point spec, 2026-06-12)
--------------------------------------------------
- Durable per-agent cursor = highest message_id already HANDLED. Persisted in the
  agent's state dir so it survives restarts.
- `--poll`  : print messages with message_id > cursor. Does NOT advance the
              cursor (crash-safe: persist only AFTER handling). Records the
              high-water mark of what it returned as `pending`.
- `--commit`: advance cursor to the recorded `pending` high-water. Run this AFTER
              you have acted on the polled messages. A message that arrived between
              the poll and the commit has id > pending, so it is never skipped --
              it simply surfaces on the next poll.
- `--sync-turn-start` (alias `--mark-current`): set cursor = latest message in the
              feed WITHOUT returning anything. MANDATORY de-dup fence: run once at
              the very start of every normal turn, because the message that woke
              this turn was already delivered through the turn boundary and would
              otherwise be replayed by the mid-loop poller and answered twice.
- `--show-state`: print the current cursor/pending.

AGENT / PATH RESOLUTION
-----------------------
Defaults are derived from the environment so the same script works for every
agent with no per-agent copy:
    agent  = --agent | $CTX_AGENT_NAME
    root   = --root  | $CTX_ROOT  (e.g. C:\\Users\\cody\\.cortextos\\default)
    feed   = <root>/logs/<agent>/inbound-messages.jsonl
    state  = <root>/state/<agent>/.live-inbound-cursor.json
Override any of them explicitly for tests.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def resolve_agent(explicit: str | None) -> str:
    agent = explicit or os.environ.get("CTX_AGENT_NAME")
    if not agent:
        raise SystemExit(
            "no agent: pass --agent or set CTX_AGENT_NAME in the environment"
        )
    return agent


def resolve_root(explicit: str | None) -> Path:
    root = explicit or os.environ.get("CTX_ROOT")
    if not root:
        raise SystemExit("no root: pass --root or set CTX_ROOT in the environment")
    return Path(root)


def read_state(path: Path) -> dict:
    if not path.exists():
        return {"cursor": 0, "pending": 0}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {
            "cursor": int(data.get("cursor", data.get("last_message_id", 0)) or 0),
            "pending": int(data.get("pending", 0) or 0),
        }
    except (OSError, ValueError, json.JSONDecodeError):
        return {"cursor": 0, "pending": 0}


def write_state(path: Path, cursor: int, pending: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps({"cursor": cursor, "pending": pending}, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)  # atomic on same volume


def read_messages(path: Path, after: int) -> list[dict]:
    messages: list[dict] = []
    if not path.exists():
        return messages
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # skip a torn/partial trailing write; reappears next poll
            message_id = int(msg.get("message_id") or 0)
            if message_id > after:
                messages.append(msg)
    messages.sort(key=lambda m: int(m.get("message_id") or 0))
    return messages


def latest_id(path: Path) -> int:
    allm = read_messages(path, 0)
    return int(allm[-1]["message_id"]) if allm else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", help="agent name (default $CTX_AGENT_NAME)")
    parser.add_argument("--root", help="cortextos root (default $CTX_ROOT)")
    parser.add_argument("--inbound", type=Path, help="override feed path")
    parser.add_argument("--state", type=Path, help="override cursor state path")
    parser.add_argument("--poll", action="store_true",
                        help="print new messages (id > cursor); does NOT advance cursor")
    parser.add_argument("--commit", action="store_true",
                        help="advance cursor to the pending high-water; run AFTER handling")
    parser.add_argument("--sync-turn-start", "--mark-current", dest="sync",
                        action="store_true",
                        help="set cursor=latest, return nothing (turn-start de-dup fence)")
    parser.add_argument("--show-state", action="store_true")
    args = parser.parse_args()

    if args.inbound:
        inbound = args.inbound
    else:
        agent = resolve_agent(args.agent)
        root = resolve_root(args.root)
        inbound = root / "logs" / agent / "inbound-messages.jsonl"

    if args.state:
        state_path = args.state
    else:
        agent = resolve_agent(args.agent)
        root = resolve_root(args.root)
        state_path = root / "state" / agent / ".live-inbound-cursor.json"

    st = read_state(state_path)

    if args.show_state:
        print(json.dumps({**st, "feed": str(inbound), "feed_latest": latest_id(inbound)},
                         indent=2))
        return

    if args.sync:
        latest = latest_id(inbound)
        write_state(state_path, cursor=latest, pending=latest)
        print(json.dumps({"synced_cursor": latest, "mode": "sync_turn_start"}, indent=2))
        return

    if args.commit:
        new_cursor = max(st["cursor"], st["pending"])
        write_state(state_path, cursor=new_cursor, pending=new_cursor)
        print(json.dumps({"committed_cursor": new_cursor}, indent=2))
        return

    # default action == --poll
    messages = read_messages(inbound, st["cursor"])
    if messages:
        pending = int(messages[-1]["message_id"])
        write_state(state_path, cursor=st["cursor"], pending=pending)
    print(json.dumps(messages, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
