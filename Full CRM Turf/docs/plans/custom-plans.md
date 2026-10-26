# Custom plans: pay for the pieces you use

**Status:** Proposed. The builder on the landing site's Pricing page already works with the draft prices in [the plans doc](README.md).
**Date:** 2026-10-27

## The problem

The four ready-made plans (Solo, Duo, Team, Pro) switch on every feature. A buyer who would pay $200 for a plan has to take all of it. A buyer who needs less, or needs one thing the plan buries inside a bigger feature, would pay about $180 for exactly that. Today they leave.

## The decision

**A plan is a set of switched-on features plus extras. The ready-made plans are only presets.** The price is always the sum, so a buyer who drops two features pays less, and nobody pays for a feature they do not use. This follows how the features are already priced: one price per feature per tier ([the features folder](../features/README.md)).

### What the builder does now (landing/web, `src/plan.js`)

| Choice | Rule |
| --- | --- |
| People | 1 uses the Solo prices; 2 uses the Duo price (one price for both); 3 or more use the Team prices per seat |
| Each of 6 features | Off, Standard (the tier's version) or Power (the Pro version, only for 3 or more people) |
| Always included | Exports, backup and restore, accounts and security |
| Extras | Minutes, texts, numbers, number lookups, active leads, campaign emails, AI reply drafts, at the add-on prices in the feature files |
| Presets | Start from Solo, Duo, Team or Pro, then change anything |
| Result | Monthly total, the saving against the ready-made plan, and a text summary saved with the waitlist sign-up |

Examples at the draft prices: Solo without the map and AI campaigns is $276 against $344. Three people with every feature at Standard is $858; with only Importing, Skip tracing, Dialer and the CRM it is $696.

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

## Open questions

1. Prices for the four modules above (or tell me to keep SMS and DNC inside their features).
2. Does a custom plan get a minimum (for example at least $49 a month), so a one-feature plan is not a loss?
3. Should dropping features ever cost less per feature than the bundle? Today it does not: the ready-made total is the plain sum, so the custom plan is never cheaper per feature.
