# Custom plans: pay for the pieces you use

**Status:** Proposed. The builder on the landing site's Pricing page already works with the draft prices in [the plans doc](README.md).
**Date:** 2026-10-27

## The problem

The four ready-made plans (Solo, Duo, Team, Pro) switch on every feature. A buyer who would pay $200 for a plan has to take all of it. A buyer who needs less, or needs one thing the plan buries inside a bigger feature, would pay about $180 for exactly that. Today they leave.

## The decision

**The CRM is a free base in every plan** (decided 2026-10-27): everyone needs it, so it is not priced or switched off. The five other features are what a buyer chooses. This lowers every ready-made total by the CRM's old price: Solo $344 to $295, Duo $554 to $475, Team $286 to $241 per seat, Pro $554 to $495 per seat (one by one, before the all-in price below).

**A plan is a set of switched-on features plus extras. The ready-made plans are only presets.** The price is always the sum, so a buyer who drops two features pays less, and nobody pays for a feature they do not use. This follows how the features are already priced: one price per feature per tier ([the features folder](../features/README.md)).

### What the builder does now (landing/web, `src/plan.js`)

| Choice | Rule |
| --- | --- |
| People on the team | The most people any feature can have |
| People per feature | **Each feature is priced for the people who use it, not the whole team.** An owner who skip traces alone pays the one-person Skip tracing price however many callers there are. 1 person uses the Solo price; 2 use the Duo price (one price for both); 3 or more use the Team price per person |

**All-in price: one person pays at most $199 a month** (decided 2026-10-27, "it needs to be under $200"). Features are still priced one by one, but the features together are held to a cap, so everything for one person is $199 instead of $295, and any mix that adds up to more than $199 (for example Importing, Skip tracing and the Dialer, $227 one by one) is also $199. The cap never lowers a price when a feature is added, so a bigger plan is never cheaper than a smaller one (a test checks every mix and team size).

| | Solo | Duo (both) | Team (per person) | Pro (per person) |
| --- | --- | --- | --- | --- |
| One by one, every feature | $295 | $475 | $241 | $495 |
| **All-in price** | **$199** | **$320** | **$163** | **$334** |

I set Duo, Team and Pro by scaling the Solo cap by the same factor (199 / 295, about 0.675) and rounding. They are proposals; the four numbers are in `ALL_IN` in `landing/web/src/plan.js`. The cap is per person, so a five-person team is held to 5 × $163. Power teams use the Pro cap.

**Margin check at the cap.** Fully used, the features cost Turf about $60 a month for one person (the dialer is about $43 of that at the old 3,000-minute cap, plus Skip tracing about $4, Importing about $3 and AI campaigns about $1 with the lower email amount). $199 leaves roughly 70%, but only while calling is capped; see the unlimited-calling caveat below. Skip tracing and Importing are 95%+ margin, so the cap mostly gives away those, not the dialer.

**Campaign emails are fewer and flexible** (decided 2026-10-27). AI campaigns includes 1,000 emails a month for Solo (was 5,000), scaled the same way for the other tiers (Duo 2,000 shared, Team 1,000 per seat, Pro 4,000 per seat). More are bought in the AI campaigns row in steps of 1,000 at **$2 per 1,000** (the old add-on was $10 per 5,000, the same rate). Cost to Turf is about $0.50 per 1,000, so about 75% margin. The AI feature's $49 list price is unchanged; say if it should drop with the smaller email amount.

**Dialer and SMS is marketed as unlimited calling plus a flexible number of texts** (decided 2026-10-27). Calling shows as "Unlimited" instead of a minutes cap, Solo includes 1,500 texts, and a buyer adds more in the Dialer row at $15 per 1,000 (the existing add-on). The "extra minutes" add-on is gone. I scaled the included texts for the other tiers by the same factor as Solo (Duo 3,000 shared, Team 1,500 per seat, Pro 6,000 per seat); correct those if you meant something else.

**Cost caveat.** `docs/features/03-dialer-auto-dialing-sms.md` priced the dialer on a 3,000-minute cap (about $33 of calls at $0.011 a minute) and 500 texts. Unlimited minutes removes that cap: a caller dialing six hours a day is about 7,900 minutes, roughly $87 of calling cost against a $99 price, before numbers, texts and registration. The site says "subject to fair use" but a fair-use limit has to be written and enforced, or Solo and Team can lose money on heavy callers. Pro's multi-line dialing burns minutes faster still. 1,500 texts at the same price also adds about $7 of cost.

| Each of 5 priced features | Off, Standard (the tier's version) or Power (the Pro version, only when 3 or more people use that feature) |
| Always included | The CRM, exports, backup and restore, accounts and security |
| Extras | Minutes, texts, numbers, number lookups, active leads, campaign emails, AI reply drafts, at the add-on prices in the feature files |
| Presets | Start from Solo, Duo, Team or Pro, then change anything |
| Result | Monthly total, the saving against the ready-made plan, and a text summary saved with the waitlist sign-up |

Examples at the draft prices: Solo without the map and AI campaigns is $227 against $295. Three people with every feature at Standard is $723; with only Importing, Skip tracing and the Dialer it is $411.

## More ready-made plans

Ten more starting points beside Solo, Duo, Team and Pro. Each is a set of switched-on features, so the price is the plain sum at the draft prices. They live in `MORE_PLANS` in `landing/web/src/plan.js`; "Customize" opens one in the builder.

| Plan | For | Features (the CRM is included in all of them) | Per month |
| --- | --- | --- | --- |
| List Cleaner | 1 person who only cleans lists | Skip tracing | $79 |
| Starter Pipeline | 1 person starting out | Importing lists, Leads map | $68 |
| Caller | 1 person who lives on the phone | Dialer and SMS | $99 |
| Data Desk | 1 researcher | Importing lists, Skip tracing, Leads map | $147 |
| Campaign Studio | 1 person who sells by email and text | Importing lists, AI campaigns | $98 |
| Lists to Dials | 1 person, list to call | Importing lists, Skip tracing, Dialer and SMS | $199 ($227 one by one) |
| Lean Partners | Exactly 2 partners | Importing lists, Skip tracing, Leads map | $217 for both |
| Owner and Callers | An owner who preps lists, and 4 callers | Importing and Skip tracing for 1 person; Dialer for 4 | $484 for 5 |
| Call Floor | 5 callers and closers | Importing lists, Skip tracing, Dialer and SMS | $815 for 5 ($935 one by one) |
| Power Callers | 3 callers who dial all day | Same three, with the Dialer at Power | $1,002 for 3 ($1,011 one by one) |

These are drafts to react to, not decisions. Names, the mix of features and the seat counts are easy to change in one file.

## Still all-or-nothing: pieces inside a feature

The two things buyers ask for by name are bundled inside bigger features:

| Piece | Inside | Today |
| --- | --- | --- |
| Do Not Call and number blocking, right-person check | Skip tracing ($79 Solo) | Cannot be bought without the rest |
| SMS | Dialer and SMS ($99 Solo) | Cannot be bought without calling |

To sell them alone, each feature needs to be split into modules with their own prices. **The prices are your call and are not in the docs**, so none are on the site. What the docs do give is the cost of each piece to Turf:

- **Dialer and SMS, Solo, fully used:** minutes ~$33, a number ~$1.50, 500 texts $3.50, texting registration ~$5 (total ~$43).
- **Skip tracing, Solo, fully used:** ~$4 in total, almost all of it lookups. The $79 price is for the value (DNC scrubbing alone is $100 a month elsewhere), not the cost.

Proposed modules, to price:

| Module | Contains | Needs from you |
| --- | --- | --- |
| List cleaning | Phone ranking, repeats, status reading, overrules | A price |
| Do Not Call and blocking | National DNC, never-call list, litigator and right-person checks | A price |
| Calling | Dial pad, power dialing, call logs, recording, voicemail drop | A price |
| Texting | SMS, registration, opt-out handling | A price |

Rule to keep plans sane: **the sum of the modules at the same level must equal today's feature price**, so splitting never makes a full plan cost more or less, and a buyer who wants only some modules pays only for those.

## What it needs behind the scenes

When billing exists, a plan is stored as entitlements, not as a plan name:

```text
subscription ──< entitlement(feature or module, level, limit overrides)
              ──< addon(kind, quantity)
```

- The server checks `entitlement` for every feature call, as it already checks plans and minutes.
- A ready-made plan is a named list of entitlements that a subscription starts from.
- Changing a plan mid-month changes the entitlements and prorates; nothing else moves.
- The desktop app asks the server for the entitlements at sign-in and hides what is off.

## Documents that still show the old CRM price

The CRM's selling price ($49 / $79 / $45 / $59) is still in `docs/features/05-crm.md` and in the plan totals of `docs/plans/README.md` (Solo $344, Duo $554, Team $286, Pro $554). They are the source documents, so they are not changed here. Update them to match this decision, and re-check the margins: the CRM was a high-margin feature (about 87-95%), so removing its price lowers the blended margin of every plan.

## Open questions

1. Prices for the four modules above (or tell me to keep SMS and DNC inside their features).
2. Does a custom plan get a minimum (for example at least $49 a month), so a one-feature plan is not a loss?
3. A person is counted once per feature. If the owner also calls, they are one of the dialer's people. Should a person who uses several features ever count as one seat for the account minimum?
4. Should dropping features ever cost less per feature than the bundle? Today it does not: the ready-made total is the plain sum, so the custom plan is never cheaper per feature.
