# Graph Attachment App — Least-Privilege Lock-Down Runbook

Locks the headless attachment app (`scripts/graph_attachment.py`) to **only the mailboxes the
cortextOS agents actually need**, so the tenant-wide app permission can in practice touch nothing else.

- **App:** the DEDICATED **"CortextOS Agents - Mail"** Entra app (separate from the AI Admin
  sign-in app). **Client ID:** `<NEW_APP_CLIENT_ID>` — fill in once Cody registers it.
- **Creds home:** `orgs/<org>/secrets.env` as `GRAPH_MAIL_CLIENT_ID` / `GRAPH_MAIL_TENANT_ID` /
  `GRAPH_MAIL_CLIENT_SECRET` (distinct names — never confused with AI Admin's `ENTRA_*`).
- **Why this exists:** app-only Graph access always requires tenant-level admin consent (no
  signed-in user to self-consent). By default that means the app could read every mailbox in the
  tenant. An **Application Access Policy** with `RestrictAccess` scopes it to a chosen group =
  least privilege. Answers "why grant for the whole tenant?" — you do, but this policy locks it down.

## Step 1 — Grant the API permission (Azure portal, ~2 min)
App registrations → **CortextOS Agents - Mail** (`<NEW_APP_CLIENT_ID>`) → API permissions →
+ Add a permission → Microsoft Graph → **Application permissions** (NOT Delegated):
- **`Mail.Read`** — sufficient for the attachment downloader (read-only; least privilege). ← recommended now
- `Mail.ReadWrite` — only if/when we add draft-writing (read + create drafts, still NOT send). Add later via re-consent.

Then **Grant admin consent for [tenant]**.

## Step 2 — Scope it to the chosen mailbox set (Exchange Online PowerShell, admin)
Requires the ExchangeOnlineManagement module + interactive Exchange admin auth (cannot run headless).
Scope = the mailboxes the agents need app-only byte access to — **Cody's call** (likely
`cody.peters@`, `ap@`, `payroll@`, `jackie@`). NOT the whole tenant, NOT artificially cody-only.
```powershell
# 0. one-time
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName <admin@loftco.com>

# 1. confirm NO existing policy for this app
Get-ApplicationAccessPolicy | ? { $_.AppId -eq "<NEW_APP_CLIENT_ID>" }

# 2. mail-enabled SECURITY group containing the chosen mailbox set (required scope type)
New-DistributionGroup -Name "CortextOS-Mail-Scope" -Alias cortextos-mail-scope `
  -Type Security -PrimarySmtpAddress cortextos-mail-scope@loftco.com `
  -Members cody.peters@loftco.com   # <- add ap@/payroll@/jackie@ etc. per Cody's list

# 3. RestrictAccess = app can touch ONLY mailboxes in that group (least privilege, NOT DenyAccess)
New-ApplicationAccessPolicy -AppId <NEW_APP_CLIENT_ID> `
  -PolicyScopeGroupId cortextos-mail-scope@loftco.com -AccessRight RestrictAccess `
  -Description "Restrict CortextOS Agents - Mail app to the chosen mailbox set (least privilege)"

# 4. verify (policy can take ~30 min to propagate)
Test-ApplicationAccessPolicy -Identity cody.peters@loftco.com -AppId <NEW_APP_CLIENT_ID>   # expect Granted
Test-ApplicationAccessPolicy -Identity <a-mailbox-NOT-in-the-group> -AppId <NEW_APP_CLIENT_ID>  # expect Denied
```

## Step 3 — Confirm live
After ~30 min propagation, Forge re-runs `python scripts/graph_attachment.py self-check --mailbox cody.peters@loftco.com`
→ expect green. Then find/download/fetch are live for any mailbox in the scope group.

**Net:** tenant-grant in name, chosen-mailbox-set-only in practice. The app physically cannot read or
draft any mailbox outside the group.
