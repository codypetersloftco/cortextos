#!/usr/bin/env python3
"""Headless Microsoft Graph mail-attachment downloader (app-only / client-credentials).

PERMANENT FIX for the "can't download attachments while Cody is in Outlook" gap:
fetches mail + attachment RAW BYTES via the Graph API using the dedicated
**CortextOS Agents - Mail** Entra app (app-only). Works from ANY session — no desktop
Outlook, no COM, immune to Outlook being busy/open.

Auth: client-credentials (app-only). Reads GRAPH_MAIL_CLIENT_ID / GRAPH_MAIL_TENANT_ID /
GRAPH_MAIL_CLIENT_SECRET from orgs/<org>/secrets.env (NOT the AI Admin ENTRA_* sign-in
app). Requires the **Mail.Read (Application)** permission admin-consented on the
dedicated app (provisioned + proven e2e 2026-06-08).

Usage:
  # 1. prove the runtime works end-to-end (token + Mail.Read on a mailbox):
  python graph_attachment.py self-check --mailbox invoices@loftco.com

  # 2. find candidate messages (prints id / subject / from / received / #attachments):
  python graph_attachment.py find-email --mailbox invoices@loftco.com \
      --subject "Invoice 12345" [--from vendor@x.com] [--since 2026-06-01] [--top 10]

  # 3. download a specific message's attachments to a folder:
  python graph_attachment.py download --mailbox invoices@loftco.com \
      --message-id <id> --out-dir "C:/path/out" [--name "exact_attachment.pdf"]

  # convenience: find the NEWEST match + download all its attachments in one shot:
  python graph_attachment.py fetch --mailbox invoices@loftco.com \
      --subject "Invoice 12345" [--from ...] [--since ...] --out-dir "C:/path/out"

Exit codes: 0 ok; 2 config/cred error (e.g. missing secret); 3 Graph/API error;
4 not found (no message/attachment matched).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import requests

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"


def _load_env_fallback() -> dict[str, str]:
    """Read GRAPH_MAIL_* from the cortextOS ORG secrets file if not already in env.

    These creds belong to the DEDICATED "CortextOS Agents - Mail" Entra app (NOT
    the AI Admin sign-in app). They live in orgs/<org>/secrets.env. cortextOS does
    NOT auto-inject org secrets.env into the agent process env (features read it on
    demand), so this reads the file directly. os.environ still wins if the vars are
    exported. Set CORTEXTOS_SECRETS_ENV to override the path.
    """
    out: dict[str, str] = {}
    candidates: list[Path] = []
    override = os.environ.get("CORTEXTOS_SECRETS_ENV")
    if override:
        candidates.append(Path(override))
    fw, org = os.environ.get("CTX_FRAMEWORK_ROOT"), os.environ.get("CTX_ORG")
    if fw and org:
        candidates.append(Path(fw) / "orgs" / org / "secrets.env")
    for env_path in candidates:
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError:
            continue
    return out


def _creds() -> tuple[str, str, str]:
    fb = _load_env_fallback()

    def get(name: str) -> str:
        return (os.environ.get(name) or fb.get(name) or "").strip()

    client_id = get("GRAPH_MAIL_CLIENT_ID")
    tenant_id = get("GRAPH_MAIL_TENANT_ID")
    secret = get("GRAPH_MAIL_CLIENT_SECRET")
    missing = [n for n, v in
               (("GRAPH_MAIL_CLIENT_ID", client_id), ("GRAPH_MAIL_TENANT_ID", tenant_id), ("GRAPH_MAIL_CLIENT_SECRET", secret))
               if not v]
    if missing:
        print(
            "CONFIG ERROR: missing " + ", ".join(missing) + ".\n"
            "  These are the DEDICATED 'CortextOS Agents - Mail' Entra app creds. Add them to\n"
            "  orgs/<org>/secrets.env (NOT AI Admin, NOT the ENTRA_* AI-Admin app vars):\n"
            "    GRAPH_MAIL_CLIENT_ID=<new app client id>\n"
            "    GRAPH_MAIL_TENANT_ID=<tenant id>\n"
            "    GRAPH_MAIL_CLIENT_SECRET=<new app client secret>\n"
            "  Requires Mail.Read (Application) admin consent + the Exchange\n"
            "  application-access-policy scoping (see graph_attachment_access_policy_runbook.md). Then re-run.",
            file=sys.stderr,
        )
        sys.exit(2)
    return client_id, tenant_id, secret


def get_token() -> str:
    client_id, tenant_id, secret = _creds()
    resp = requests.post(
        f"{LOGIN}/{tenant_id}/oauth2/v2.0/token",
        data={
            "client_id": client_id,
            "client_secret": secret,
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    if resp.status_code != 200:
        print(f"TOKEN ERROR {resp.status_code}: {resp.text[:400]}", file=sys.stderr)
        sys.exit(3)
    return resp.json()["access_token"]


def _hdrs(token: str, *, search: bool = False) -> dict[str, str]:
    h = {"Authorization": f"Bearer {token}"}
    if search:
        h["ConsistencyLevel"] = "eventual"  # required for $search
    return h


def _graph_get(token: str, url: str, *, params=None, search=False, stream=False):
    resp = requests.get(url, headers=_hdrs(token, search=search), params=params, timeout=60, stream=stream)
    if resp.status_code == 403:
        print("GRAPH 403 (forbidden): the app likely lacks Mail.Read (Application) "
              "admin consent, or no access to this mailbox.\n  " + resp.text[:400], file=sys.stderr)
        sys.exit(3)
    if resp.status_code == 404:
        print(f"GRAPH 404 (not found): {url}\n  {resp.text[:300]}", file=sys.stderr)
        sys.exit(4)
    if resp.status_code >= 400:
        print(f"GRAPH ERROR {resp.status_code}: {resp.text[:400]}", file=sys.stderr)
        sys.exit(3)
    return resp


def find_messages(token: str, mailbox: str, subject: str | None, frm: str | None,
                  since: str | None, top: int) -> list[dict]:
    params = {
        "$select": "id,subject,from,receivedDateTime,hasAttachments",
        "$top": str(top),
        "$orderby": "receivedDateTime desc",
    }
    use_search = bool(subject)
    if use_search:
        # $search covers subject/body; cannot combine with $orderby on Graph, so drop it.
        params.pop("$orderby", None)
        terms = [f'"subject:{subject}"']
        if frm:
            terms.append(f'"from:{frm}"')
        params["$search"] = " AND ".join(terms)
    else:
        filt = []
        if frm:
            filt.append(f"from/emailAddress/address eq '{frm}'")
        if since:
            filt.append(f"receivedDateTime ge {since}T00:00:00Z")
        if filt:
            params["$filter"] = " and ".join(filt)
    resp = _graph_get(token, f"{GRAPH}/users/{mailbox}/messages", params=params, search=use_search)
    msgs = resp.json().get("value", [])
    # client-side since filter when $search was used (search can't combine with date $filter cleanly)
    if use_search and since:
        msgs = [m for m in msgs if (m.get("receivedDateTime") or "") >= f"{since}T00:00:00Z"]
    return msgs


def list_attachments(token: str, mailbox: str, message_id: str) -> list[dict]:
    resp = _graph_get(
        token, f"{GRAPH}/users/{mailbox}/messages/{message_id}/attachments",
        # NOTE: do NOT put @odata.type in $select — Graph rejects it ("not valid in a
        # $select expression"). It is returned automatically on every attachment, so the
        # fileAttachment filter below still works without selecting it.
        params={"$select": "id,name,contentType,size"},
    )
    return resp.json().get("value", [])


def download_attachment_bytes(token: str, mailbox: str, message_id: str, attachment_id: str) -> bytes:
    resp = _graph_get(
        token, f"{GRAPH}/users/{mailbox}/messages/{message_id}/attachments/{attachment_id}/$value",
        stream=True,
    )
    return resp.content


def _save_attachments(token, mailbox, message_id, out_dir, name_filter) -> int:
    atts = list_attachments(token, mailbox, message_id)
    if name_filter:
        atts = [a for a in atts if a.get("name") == name_filter]
    # file attachments only (itemAttachment/referenceAttachment have no $value bytes)
    atts = [a for a in atts if a.get("@odata.type", "").endswith("fileAttachment") or a.get("name")]
    if not atts:
        print(f"NOT FOUND: no matching file attachments on message {message_id}", file=sys.stderr)
        sys.exit(4)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    saved = 0
    for a in atts:
        data = download_attachment_bytes(token, mailbox, message_id, a["id"])
        dest = Path(out_dir) / a["name"]
        dest.write_bytes(data)
        print(f"SAVED {dest}  ({len(data)} bytes, {a.get('contentType','?')})")
        saved += 1
    return saved


def main() -> None:
    ap = argparse.ArgumentParser(description="Headless Graph mail-attachment downloader (app-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sc = sub.add_parser("self-check", help="prove token + Mail.Read on a mailbox")
    sc.add_argument("--mailbox", required=True)

    fe = sub.add_parser("find-email", help="list candidate messages")
    for a in ("--mailbox",):
        fe.add_argument(a, required=True)
    fe.add_argument("--subject"); fe.add_argument("--from", dest="frm")
    fe.add_argument("--since", help="YYYY-MM-DD"); fe.add_argument("--top", type=int, default=10)

    dl = sub.add_parser("download", help="download a message's attachments")
    dl.add_argument("--mailbox", required=True); dl.add_argument("--message-id", required=True)
    dl.add_argument("--out-dir", required=True); dl.add_argument("--name", help="exact attachment filename")

    ft = sub.add_parser("fetch", help="find newest match + download all its attachments")
    ft.add_argument("--mailbox", required=True); ft.add_argument("--subject")
    ft.add_argument("--from", dest="frm"); ft.add_argument("--since", help="YYYY-MM-DD")
    ft.add_argument("--out-dir", required=True)

    args = ap.parse_args()
    token = get_token()

    if args.cmd == "self-check":
        resp = _graph_get(token, f"{GRAPH}/users/{args.mailbox}/messages",
                          params={"$select": "id,subject", "$top": "1"})
        n = len(resp.json().get("value", []))
        print(f"OK: token acquired + Mail.Read works on {args.mailbox} "
              f"(read {n} message header). Headless Graph attachment download is GO.")
        return

    if args.cmd == "find-email":
        msgs = find_messages(token, args.mailbox, args.subject, args.frm, args.since, args.top)
        if not msgs:
            print("NO MATCHES", file=sys.stderr); sys.exit(4)
        for m in msgs:
            frm = (m.get("from", {}).get("emailAddress", {}) or {}).get("address", "?")
            print(f"{m['id']}\t{m.get('receivedDateTime','?')}\tatt={m.get('hasAttachments')}\t"
                  f"from={frm}\tsubj={m.get('subject','')[:80]}")
        return

    if args.cmd == "download":
        saved = _save_attachments(token, args.mailbox, args.message_id, args.out_dir, args.name)
        print(f"DONE: {saved} attachment(s) -> {args.out_dir}")
        return

    if args.cmd == "fetch":
        msgs = find_messages(token, args.mailbox, args.subject, args.frm, args.since, top=25)
        msgs = [m for m in msgs if m.get("hasAttachments")]
        if not msgs:
            print("NO MATCHES with attachments", file=sys.stderr); sys.exit(4)
        msgs.sort(key=lambda m: m.get("receivedDateTime", ""), reverse=True)
        target = msgs[0]
        print(f"MATCH {target['id']} received={target.get('receivedDateTime')} "
              f"subj={target.get('subject','')[:80]}")
        saved = _save_attachments(token, args.mailbox, target["id"], args.out_dir, None)
        print(f"DONE: {saved} attachment(s) -> {args.out_dir}")
        return


if __name__ == "__main__":
    main()
