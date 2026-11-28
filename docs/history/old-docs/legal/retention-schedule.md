# Retention and deletion schedule

Settled for now on the **cautious side**. Where the owner wanted to keep more (the learned copy after a customer deletes), the default is the safer rule below until a lawyer says otherwise.

| Data | Where | Kept | Deleted by | How |
|---|---|---|---|---|
| Accounts: name, email, profile, date of birth, security events | auth database | while the account exists | the account owner's request; within 30 days | manual today (owner runs the deletion; an account-deletion screen is not built) |
| Customer Data: leads, notes, calls, tasks, deals | crm-core database | while the workspace exists | the customer deleting a list or lead; closure on request within 30 days | list deletion exists; closure is manual |
| Uploaded list files | import disk | until loaded into the database | automatic, within a minute of loading | worker |
| Import holding rows (raw values) | crm-core database | 7 days after the list is copied to the learning store; 14 days if the import failed or was cancelled | automatic | `scrubLearned`, `sweepRows` (completed imports keep only a fingerprint and the link to the lead) |
| **Learning copy** (hashes and shapes) | learning database | **2 years** from copying | automatic hourly purge; **sooner** when the customer switches it off, deletes the list, closes the workspace, or a person asks | `purge`, opt-out, `DELETE /v1/workspaces/{org}/projects/{list}`, `DELETE /v1/workspaces/{org}`, `POST /v1/erase-everywhere` |
| Removal requests (suppression list) | learning database | until the owner decides otherwise (a keyed hash only) | | they are kept so the person is not added again |
| Audit counts (what was erased or purged) | learning database | 7 years (proof of compliance; counts only) | | |
| Contact messages | notifications mailbox | [TO CONFIRM] | | |
| Technical logs | Coolify | [TO CONFIRM] | | |
| Billing records | Paddle | as tax law requires | | |

## The decision that was open: keeping the learned copy after a customer deletes

- **Deleting a list:** the learning copy of that list is erased now (built).
- **Closing a workspace:** the learning copy of the workspace is erased (the owner runs `DELETE /v1/workspaces/{org}`; closure itself is manual).
- **What stays:** counts that identify no person and no workspace (for example how often a column title meant "phone"), and the suppression list.
- **If the owner wants to keep per-person learned rows after deletion:** that needs the lawyer's approval, a clear sentence in the Terms and Privacy Notice, and a way for a person to still be removed (erase-everywhere already works). Until then the rule above applies.

## Backups

[BACKUP POLICY TO CONFIRM: whether Coolify database backups are on, where they go, how long they are kept, and how erased data leaves them. The Terms say backups are overwritten on their normal cycle.]
