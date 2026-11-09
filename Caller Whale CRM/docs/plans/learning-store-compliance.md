# Learning store: what it keeps, and what must be true before it is switched on

This is a working note for the owner and for the lawyer who will read the terms. It is not legal advice. The rule it follows: **law first, product second.** The service ships switched off (`LEARNING_ENABLED=false`) and stays off until the checklist at the end is done.

## What it is

A separate container (`services/learning`, port 8112, no public address) with its own PostgreSQL database (`learning`, its own login). crm-core sends it a finished import once; it keeps a *learned copy* of each lead and the flags people later give the lead, and uses them to suggest column mappings, spot junk and give early feedback on new leads.

## What is kept, and what is never kept

| Kept | How |
|---|---|
| Phone, email | Only as a keyed hash (HMAC-SHA256). The key (`LEARNING_HASH_KEY`) is held only by the platform owners. A hash cannot be turned back into a phone or an email; it can only be matched against one you already have. |
| Name | Only its shape: "person" with the number of words, or "company". |
| Address | Only city, state, five-digit ZIP and country. No street, no number, no unit, no coordinates; only that an address, a unit and a location were present. |
| Property facts | From a fixed list (beds, baths, year built, size, type and so on). Anything else in a list is dropped. |
| Flags | From a fixed list (stage, verdict, do not call, call outcome, priority, interested), short values only. |
| Column titles | Which title meant which field, counted. Titles carry no personal details. |

**Never kept:** names, phones, emails, street addresses, units, coordinates, free text, call recordings or notes. A test (`learning_test.go`) puts a real-looking row through and fails if any of it can be found in the database.

The owner's earlier idea of an encrypted copy of the raw row that the owners could read back (tier 2) is **not built.** It would keep real personal details of people who never dealt with Caller Whale, and it needs the lawyer's yes first.

## Principles, and where the code does them

- **Data minimisation:** the shapes above; the allow-lists in `shape.go`.
- **Purpose limitation:** the store has no screens and no export. Only the platform owners' learning jobs may read it (not built yet).
- **Storage limitation:** every row expires (`LEARNING_RETENTION_DAYS`, default 730) and an hourly purge removes it; each purge and erasure leaves a count in `learning.audit`.
- **Erasure and objection:** `POST /v1/erase-person` removes one person's rows (by phone or email); `POST /v1/workspaces/{org}/opt-out` and `DELETE /v1/workspaces/{org}` remove a workspace's rows and stop any more being taken. crm-core exposes opt-out and opt-in to workspace administrators (`POST /api/v1/learning/opt-out`, `/opt-in`). Erasure works even while learning is switched off.
- **Integrity and confidentiality:** its own database and login, no public address, one bearer token (constant-time compare), bodies limited to 8 MB, errors logged by type only (never a value), distroless non-root image.
- **Accountability:** this note, the audit table, and the switch.
- **The working database:** a week after a copy, the holding rows of the import lose their personal details (`scrubLearned`); only the fingerprint, state and link to the lead stay (so adding the same file again is still recognised).

## Things the law will ask about (to settle with the lawyer, not decided here)

1. **Role.** The customers decide why they hold their leads; using them for Caller Whale's own learning makes Caller Whale more than a processor for that use. The terms must say so and need a data processing agreement that allows it.
2. **Legal basis** for the people in the lists (they never met Caller Whale): most likely legitimate interests with a written balancing test, or the customers' own basis plus a clause. Different in the EU/UK, California and elsewhere.
3. **Notice.** The privacy notice must name this use, the two-year retention, the hashing, and how to object. Customers must be able to tell the people in their lists.
4. **Pseudonymous is still personal data** where a phone or email can be tried against the hash. Treat the store and the key as personal data.
5. **Keeping the learned copy after a customer deletes a list** (the owner's wish): allowed only if the notice says it and a person can still have their rows removed (erase-person does that). On a workspace's closure the opt-out erases it unless the lawyer says otherwise.
6. **Do-not-call and calling law** (TCPA, DNC registries, GDPR, ePrivacy) are untouched by this store; it only records the do-not-call flag, it does not decide who may be called.
7. **Where the data lives** (the server's country) and any transfer.
8. **A data protection impact assessment** is advisable before switching on.

## Before `LEARNING_ENABLED=true`

- [ ] Terms and privacy notice updated and read by a lawyer.
- [ ] Customer agreement (DPA) allows the use.
- [ ] A data protection impact assessment written.
- [ ] The opt-out visible to workspace administrators in the CRM (the route exists; the screen does not yet).
- [ ] A way to receive and act on a person's request to be removed (an address in the notice, and someone who runs erase-person).
- [ ] `LEARNING_HASH_KEY` backed up away from Coolify, with two owners holding it.
- [ ] A breach plan covering this database.

## Not built yet

- The flags: `POST /v1/outcomes` exists, crm-core does not send outcomes yet.
- The jobs that learn from the store (suggestions, feedback on new leads).
- The opt-out screen in the CRM.
