# Legal package (status 2026-11-10)

Everything a US privacy and technology lawyer needs to review Caller Whale is in this folder or linked from it. **Nothing here has been reviewed by a lawyer.** The customer-facing texts are published on the site as the current version, with the gaps marked in yellow as `[PLACEHOLDERS]`; the internal procedures are working documents.

| Document | Who it is for | Where it lives |
|---|---|---|
| Terms of Service | customers | `landing/site/src/legal/terms.md` (page `/terms`) |
| Privacy Notice | everyone | `landing/site/src/legal/privacy.md` (`/privacy`) |
| Data Processing Addendum | customers | `landing/site/src/legal/dpa.md` (`/dpa`) |
| Acceptable Use and Calling Policy | customers | `landing/site/src/legal/acceptable-use.md` (`/acceptable-use`) |
| Remove my information (public page) | people in lists | page `/remove-my-information` |
| **Lawyer brief** (facts, data map, questions, what to fill) | the lawyer | [lawyer-brief.md](lawyer-brief.md) |
| Retention and deletion schedule | owner, lawyer | [retention-schedule.md](retention-schedule.md) |
| Breach response plan | owner | [breach-response-plan.md](breach-response-plan.md) |
| Key custody procedure | owners | [key-custody.md](key-custody.md) |
| US law map (research with sources) | lawyer | [../plans/learning-store-us-law.md](../plans/learning-store-us-law.md) |
| Learning store compliance note | lawyer | [../plans/learning-store-compliance.md](../plans/learning-store-compliance.md) |

## How the texts reach the product

- A text's **version** line (for example `Version 2026-11-10`) must equal `TERMS_VERSION` in `landing/site/src/setup.ts` and `termsVersion` in `services/auth/onboarding.go`. A test (`landing/site/tests/legal.test.mjs`) checks the site side. Changing the version makes **every** account accept the new text at its next sign-in (the sign-up and setup screens already ask).
- Change a text by editing its `.md` file, bumping the version line in all four, `TERMS_VERSION` and `termsVersion`, then deploying the auth service first and the website second (the auth service still accepts the previous version for a while so nobody is locked out in between).
- `[PLACEHOLDERS]` in capitals are drawn highlighted. The test does not block them, so search for `\[[A-Z]` in `landing/site/src/legal` before relying on a text.
