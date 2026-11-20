# Journeys, account states and permissions

Status: Proposed. Parent: [Master plan](README.md). Contracts: [Architecture](06-architecture-contracts.md).

## Stable access states

| State | Dashboard outcome | Next action |
| --- | --- | --- |
| Public visitor | Neutral shell/entry prompt, no account payload | Sign in or request access |
| Signed in, no invitation | Account identity/security where authorized; no claimed product entitlement | Explain access request and account switching |
| Invited, email unverified | Confirmation task dominates | Open email, resend under cooldown, refresh proof |
| Active invited customer | Overview/usage/download subject to server flags | Useful next task |
| Active, credits exhausted | Explain limit and exact server period; do not invent suspension | Review usage/contact; downloads follow can_download |
| Suspended/disabled | Safe restricted state; do not repeatedly refresh to bypass | Support/sign out; clarify identity vs product restriction |
| Staff without customer invitation | Staff-aware overview and normal security tools | Explicit new elevation ceremony |
| Staff also customer | Normal customer view plus authorized staff entry | Keep mode visibly distinct |
| Staff permission revoked | Elevated data/actions invalidated | Exit elevated mode; reload permitted account state |

Do not force every identity/access failure into “wrong password.” Unauthorized means a server decision; inaccessible network means unavailable. Preserve that distinction.

## Journey J01: visitor to access request

Home -> workflow/product proof -> pricing/features if useful -> one access form -> actual stored receipt. No automatic account or invitation. Duplicate/uncertain results get a safe acknowledgement/reconciliation policy. Confirmation delivery is verified independently.

## J02: returning user

Choose Google/Apple or email. Email-first proceeds to password without an existence-disclosing precheck. Keep signup a deliberate choice. After first-leg proof, show any required challenge. Finish once, load authorized account, then allowlisted destination/dashboard. Provider account mismatch offers switch-account guidance without leaking invitation details.

Callback/network/refresh concurrency must not exchange a one-time code twice. The callback component and session bootstrap coordinate; failed account loading does not silently throw away a valid auth session.

## J03: invited signup and email ownership

Invitation email -> correct existing signup/signin destination -> server enforces invitation/public-registration policy -> identity created/authenticated -> ownership proof if needed -> core activates eligible invitation -> dashboard.

The current core invitation model is matched by email/verification. Do not invent a signed accept-token route without a backend contract. New /accept-invitation is a future option only if needed; old sent links must still work.

Profile fields are minimal. Do not auto-link two provider identities solely because their email strings happen to match; use the auth service's verified linking policy and fresh proof.

## J04: recovery

Forgot -> generic acknowledgement -> actual delivered reset link -> capture/scrub token -> new compliant password -> sessions invalidated per contract -> sign in. Cover provider-only identity, existing session, expired/used link, multiple recent reset requests and offline verification. Never show a reusable reset proof in analytics/history.

## J05: second step and device approval

Render only configured available methods. Keep challenge identity and expiry authoritative on the server. Display method switch, resend cooldown and clear denial/expiry. Stop polling on unmount/terminal state and avoid overlapping polls.

Approval appears on the downloaded desktop app already signed in with suitable assurance; mobile remains future. Display requesting device/time and attempt context. Approval is bound to the requesting challenge/session, single-use and cannot approve the same compromised request with an unverified newly created session. Enrollment is distinct from signing in.

## J06: work entitlement and download

Account -> exact credit period/usage -> authorized download request -> expiring asset -> supported installer -> desktop signs in through central auth. Website cannot claim installed-app update health merely from the release-feed version. A depleted meter does not necessarily revoke can_download.

## J07: staff mode

Explicit Enter -> fresh proof for this entry -> server issues scoped elevation -> staff UI/actions/private monitoring -> Exit, idle limit, absolute expiry, logout or revocation -> new entry requires fresh proof. Background polling does not extend human presence.

Proposed policy for design/testing: 10-minute idle limit, 1-hour absolute limit, single-entry fresh verification. Existing Grafana examples use 10m idle/1h max/15m auth freshness; a 15-minute-old normal sign-in must not automatically satisfy the new-entry requirement. Reconcile these through one server policy before implementation. Cross-tab behavior uses one documented session/elevation model; a restored tab cannot silently reopen staff mode.

## Permission matrix

| Action | Customer | Platform admin | Platform owner |
| --- | --- | --- | --- |
| Own account/security | Own authorized identity | Own identity | Own identity |
| Own usage/download | Server entitlement only | Server entitlement/staff policy | Server entitlement/staff policy |
| Read customer invitation/access summaries | No | Elevated, server role checked | Elevated, server role checked |
| Invite/resend/change customer limit | No | According to actual endpoint role rules | According to actual endpoint role rules |
| Suspend customer/workspace | No | Permitted target rules; no self/staff bypass | Permitted target rules |
| Name/remove platform staff | No | No | Elevated owner only |
| Set workspace plan/unlimited | No | Do not assume; inspected source describes owner restriction | Owner endpoint rules |
| Read customer CRM records | No cross-account | No blanket right from management UI | No blanket right from management UI |
| Monitoring | No | Elevated private proxy policy | Elevated private proxy policy |

Workspace owner is not platform owner. Hiding a control never substitutes for the corresponding API refusal. Verify actual rules endpoint by endpoint before assigning buttons.

## Journey acceptance

For each J01–J07 record happy path, interrupted path, expired proof, duplicate action, permission change during use, API failure and mobile/keyboard path. Test a customer guessing staff endpoints and revoked staff retaining an old UI. All privilege transitions are auditable.
