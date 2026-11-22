# Usage credits: current state and proposed contract

Reviewed 2026-11-05 against the code in this checkout. This is a product and service design, not a live credit balance.

## What actually runs here

- Billing has a private `POST /v1/reservations` with `kind=credits`, `account_id` (person), `amount`, and `request_id`. It locks a monthly limit row, counts the current UTC month's ledger, rejects amounts over the limit, and treats a repeated request ID with a different amount as a conflict. A person without a limit gets `limited=false` and no ledger entry.
- Billing has a private `PUT /v1/people/{user_id}/credit-limit`. It can set a monthly limit from zero to one billion or remove the limit. There is no customer-facing balance or usage history route in this service.
- This checkout has no core API source under `services/core-api` and no active caller of Billing's credit reservation in the desktop/site source. Older launch docs describing `/api/v1/credits/use`, Skip Tracing debit, and invitation credit limits refer to a previous architecture. They do not establish that the current product charges credits.
- Call minutes are a separate `kind=minutes` reservation against a workspace subscription. They have a different period and account scope. The current landing pricing code advertises **unlimited calling** and **offline Skip Tracing**, so the older minute and per-row credit limits are not a sound basis for the current public offer.

## Recommendation

Use **workspace pooled usage credits** for operations whose server-side cost we can measure. Keep call minutes separate until there is a real reason to convert them. For each action, the server should own a versioned price: `feature`, `unit` (for example, one successfully checked phone), `credits_per_unit`, and effective date. The client sends the work request and an idempotency key; the service determines units and reserves the amount before paid work, then settles actual units or reverses unused reservations. Never accept a client-selected credit amount as authoritative.

The first candidate is a future paid server-side data lookup or enrichment request with a known provider cost. A local-only Skip Tracing lookup can be metered for guidance but cannot be enforced as a paid credit cap, and current pricing explicitly says it works offline. Do not display a purchasable credit package or promise a balance until the metered operation and the balance API exist. Keep the advertised unlimited calling promise separate from any internal minute ledger.

## Contract to build before launch

1. Decide the first billable operation and its unit cost from measured provider/API costs. Record the cost and margin assumption beside the price version.
2. Store grants and charges in an append-only ledger: workspace, feature, unit count, price version, grant/charge/reversal, request ID, operation ID, UTC timestamp and actor. Make retries with the same request ID return the same result; mismatched payload is a conflict.
3. Support reserve → settle/reverse so a failed, canceled, or partially completed task does not consume the full estimate. Limit checks and ledger writes must be atomic.
4. Expose a server-authorized balance response with allowance, used, reserved, remaining, period start/end and recent activity. Distinguish no limit from a zero balance. The dashboard should render this response, not calculate its own authoritative balance.
5. Apply plan grants at a specified reset boundary; define whether purchased top-ups expire or roll over. Warn at 80% and 100%. Keep platform staff usage visible even if staff have an unlimited allowance.
6. Migrate the existing person-level limits only after deciding whether they should become workspace grants, remain staff exceptions, or be retired. Run both calculations in shadow mode and compare before switching enforcement.

The grant/balance model follows [OpenMeter's metered entitlement documentation](https://openmeter.io/docs/billing/entitlements/quickstart); its [grant documentation](https://openmeter.io/docs/billing/entitlements/grant) shows why expiration, rollover, and top-ups need explicit rules. Those are design references, not a decision to add OpenMeter as a dependency.
