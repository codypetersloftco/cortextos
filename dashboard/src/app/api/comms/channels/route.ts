import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot } from '@/lib/config';
import { resolveIdentity, buildPairKey } from '@/lib/comms-identity';

export const dynamic = 'force-dynamic';

interface BusMessage {
  id: string;
  from: string;
  to: string;
  priority: string;
  timestamp: string;
  text: string;
  reply_to: string | null;
}

interface Channel {
  pair: string; // "agent1--agent2" (alphabetically sorted)
  agents: [string, string];
  last_message: { text: string; timestamp: string; from: string };
  message_count: number;
  last_activity: string;
  archived: boolean;
}

const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * GET /api/comms/channels — List active agent-pair channels.
 *
 * Groups bus messages by sender-recipient pair.
 *
 * Query params:
 *   include_archived — show archived channels (default false)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const includeArchived = searchParams.get('include_archived') === 'true';

  const ctxRoot = getCTXRoot();
  const identity = resolveIdentity(ctxRoot);
  const inboxBase = path.join(ctxRoot, 'inbox');

  if (!fs.existsSync(inboxBase)) {
    return Response.json([]);
  }

  // Primary source: persistent message history log (JSONL)
  const allMessages: BusMessage[] = [];
  const historyLog = path.join(ctxRoot, 'logs', 'message-history.jsonl');
  if (fs.existsSync(historyLog)) {
    try {
      const lines = fs.readFileSync(historyLog, 'utf-8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: BusMessage = JSON.parse(line);
          if (msg.id && msg.from && msg.to && msg.timestamp) {
            allMessages.push(msg);
          }
        } catch { /* skip */ }
      }
    } catch { /* empty */ }
  }

  // Surface bus messages still sitting in inbox dirs that are not in the
  // history log. The user pseudo-agent ("admin") has no PTY/fast-checker, so
  // agent replies sent to it via `bus send-message admin` pile up in
  // inbox/admin/ and are never written to message-history.jsonl — without this
  // scan the channels LIST never reflects them and the conversation never shows
  // the new reply (the surfacing bug). Mirrors the inbox fallback already in the
  // sibling channel/[pair] + feed routes. Scans only inbox/<agent>/ subdirs
  // (root, inflight, processed) — NOT the top-level processed/ archive — so the
  // list surfaces pending + drained-on-serve replies without dumping the full
  // agent<->agent history into the conversation list.
  let inboxAgentDirs: string[];
  try {
    inboxAgentDirs = fs.readdirSync(inboxBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { inboxAgentDirs = []; }
  for (const agent of inboxAgentDirs) {
    for (const sub of ['', 'inflight', 'processed']) {
      const dir = sub ? path.join(inboxBase, agent, sub) : path.join(inboxBase, agent);
      if (!fs.existsSync(dir)) continue;
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      } catch { continue; }
      for (const file of files) {
        try {
          const msg: BusMessage = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          if (msg.id && msg.from && msg.to && msg.timestamp) allMessages.push(msg);
        } catch { /* skip corrupt */ }
      }
    }
  }

  // Include Telegram messages
  const logsBase = path.join(ctxRoot, 'logs');
  if (fs.existsSync(logsBase)) {
    let agentLogDirs: string[];
    try {
      agentLogDirs = fs.readdirSync(logsBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch { agentLogDirs = []; }

    // Voice transcript dedup — two-pass bestByMsgId map so transcript
    // entries beat empty stubs with the same Telegram message_id.
    // See channel/[pair]/route.ts for the full explanation.
    for (const agent of agentLogDirs) {
      for (const logFile of ['inbound-messages.jsonl', 'outbound-messages.jsonl']) {
        const filePath = path.join(logsBase, agent, logFile);
        if (!fs.existsSync(filePath)) continue;
        const bestByMsgId = new Map<string, BusMessage>();
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
          const isInbound = logFile.startsWith('inbound');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const raw = JSON.parse(line);
              if (!raw.timestamp) continue;
              // Honor the entry's own bus id when present (dashboard chat
              // messages carry one) so the dedup below collapses it against
              // any bus/history copy. Genuine Telegram entries (message_id
              // only) get a synthesized tg-* id. Mirrors channel/[pair]/route.ts.
              const msgId = (typeof raw.id === 'string' && raw.id)
                ? raw.id
                : `tg-${isInbound ? 'in' : 'out'}-${agent}-${raw.message_id || raw.timestamp}`;
              const fromName = isInbound ? identity.canonicalUser : agent;
              const toName = isInbound ? agent : identity.canonicalUser;
              const candidate: BusMessage = {
                id: msgId,
                from: fromName,
                to: toName,
                priority: 'normal',
                timestamp: raw.timestamp,
                text: raw.text || raw.transcript || '',
                reply_to: null,
              };
              const existing = bestByMsgId.get(msgId);
              if (!existing) {
                bestByMsgId.set(msgId, candidate);
              } else if (!existing.text && candidate.text) {
                bestByMsgId.set(msgId, candidate);
              }
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }
        for (const msg of bestByMsgId.values()) {
          if (!msg.text) continue;
          allMessages.push(msg);
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = allMessages.filter(m => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Group by agent pair
  const channelMap = new Map<string, BusMessage[]>();
  for (const msg of unique) {
    const pair = buildPairKey(msg.from, msg.to, identity);
    if (!channelMap.has(pair)) channelMap.set(pair, []);
    channelMap.get(pair)!.push(msg);
  }

  const now = Date.now();
  const channels: Channel[] = [];

  for (const [pair, msgs] of channelMap) {
    msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latest = msgs[0];
    const lastActivity = new Date(latest.timestamp).getTime();
    const archived = (now - lastActivity) > ARCHIVE_THRESHOLD_MS;

    if (!includeArchived && archived) continue;

    const agents = pair.split('--') as [string, string];
    channels.push({
      pair,
      agents,
      last_message: { text: latest.text, timestamp: latest.timestamp, from: latest.from },
      message_count: msgs.length,
      last_activity: latest.timestamp,
      archived,
    });
  }

  // Sort by last activity descending
  channels.sort((a, b) => b.last_activity.localeCompare(a.last_activity));

  // Part 2 (marks-on-serve drain): the user pseudo-agent ("admin") has no
  // PTY/fast-checker to drain its inbox, so served replies pile up and keep the
  // silent-failure canary (non-recursive *.json count in inbox/<user>/) above 0
  // forever. Now that they've been SURFACED above, drain the USER inbox ONLY —
  // never a real agent's inbox, whose live fast-checker owns it (draining that
  // would steal undelivered messages). For each pending reply: (a) persist it to
  // message-history.jsonl (durable; every comms route reads it as primary) then
  // (b) MOVE the file into inbox/<user>/processed/ — the non-recursive canary
  // ignores the subdir so the count drops to 0 without deleting, and the message
  // stays readable (this route + channel/[pair] both scan processed). Couples
  // surface+drain per serve, so it beats the canary's 4h age-gate naturally.
  // Self-limiting: once the root is empty, subsequent polls no-op.
  try {
    const userInbox = path.join(inboxBase, identity.canonicalUser);
    // STRUCTURAL SAFETY: never drain an inbox owned by a REAL agent — a live
    // fast-checker consumes it, and draining would steal undelivered messages.
    // The user pseudo-agent is by definition NOT in the agent roster; if
    // ADMIN_USERNAME is ever misconfigured to an agent name, skip the drain
    // entirely rather than rely on that config being correct.
    if (!identity.agents.has(identity.canonicalUser) && fs.existsSync(userInbox)) {
      const pending = fs.readdirSync(userInbox).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      if (pending.length > 0) {
        const histLog = path.join(ctxRoot, 'logs', 'message-history.jsonl');
        fs.mkdirSync(path.dirname(histLog), { recursive: true });
        const processedDir = path.join(userInbox, 'processed');
        fs.mkdirSync(processedDir, { recursive: true });
        for (const file of pending) {
          try {
            const src = path.join(userInbox, file);
            const msg = JSON.parse(fs.readFileSync(src, 'utf-8'));
            if (msg.id && msg.from && msg.to && msg.timestamp) {
              fs.appendFileSync(histLog, JSON.stringify(msg) + '\n');
            }
            fs.renameSync(src, path.join(processedDir, file));
          } catch { /* locked/corrupt/raced — left in root, retried next serve */ }
        }
      }
    }
  } catch { /* drain is best-effort; it must never break the response */ }

  return Response.json(channels);
}
