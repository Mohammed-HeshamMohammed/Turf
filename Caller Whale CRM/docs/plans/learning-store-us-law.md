# Learning store: United States law map (research notes, 2026-11-10)

**Read this first.** Nobody can make a data practice "100% legal" in the United States, and this note cannot certify one: US privacy law is dozens of state statutes, federal statutes by sector, regulator guidance and court rulings that change every few months, and some facts (who the customers are, where they are, what they do with the calls) are not known here. This is a researched map of the rules that apply, the design rules the code now follows because of them, and the exact questions a US privacy attorney must answer before the learning copy is relied on. Sources are listed at the end; items marked **(verify)** came from secondary sources (law-firm blogs, trackers) and must be checked against the statute or the regulator's page.

## 1. What the learning store does (the facts the law applies to)

Lists of property owners and leads (names, phones, emails, addresses) are uploaded by Caller Whale's customers. After a list is added, crm-core copies each lead to the learning store as: keyed hashes of the phone and the email, the shape of the name, city/state/ZIP, a few property facts, and the flags the customer's team gives the lead. No names, phones, emails, street addresses or free text are kept. Rows expire after 730 days; a workspace can opt out (which erases its rows); a person can be erased everywhere.

The people in the lists have **no relationship with Caller Whale**, and Caller Whale is **not the one who collected their data**: the customer was.

## 2. Federal law

| Law | Does it reach this? | What follows for the design |
|---|---|---|
| **FTC Act section 5** (unfair or deceptive acts) | Yes. Whatever Caller Whale tells customers must be true, and an unexpected use of data can be called unfair. The FTC has ordered **deletion of models built from improperly collected or used data** ("algorithmic disgorgement": Cambridge Analytica 2019, Everalbum 2021, and later cases) (verify current posture). | The screen and the notice may say only what the code does. Every learned row carries its workspace and import, so data and anything learned from it can be found and removed. Keep it that way for any future model. |
| **TCPA** and FCC rules (calls and texts) | Not the store, but the product it feeds. The FCC's one-to-one consent rule was vacated (11th Cir., Jan 2025); revocation rules changed in 2025 and part of them is delayed (verify the date, one source says Jan 2027). | The store only records the do-not-call flag; it never decides who may be called. The CRM must keep honouring revocation and the National Do Not Call Registry. |
| **FCRA** (consumer reports) | Only if the learned scores were used to decide credit, insurance, employment, tenancy or similar eligibility. Lead feedback for sales calls is not that. | **Rule: the learning output is never used for eligibility decisions about a person**, and never sold or given to anyone who does. |
| **GLBA, HIPAA, COPPA, DPPA** | Not unless a customer uploads data under them (bank customers, patient lists, children, motor-vehicle records). | Customer terms must forbid uploading such data; this is also a cheap defence. Skip-tracing sources need their own review (GLBA and DPPA permissible purposes). |
| **CAN-SPAM** | Email marketing by customers, not the store. | Nothing for the store. |
| **No general federal privacy law** exists; Congress has not passed one. | | State laws do the work. |

## 3. State comprehensive privacy laws

About **20 states** had a comprehensive consumer privacy law in effect by mid-2026 and more are enacted (sources disagree on the count: 19 to 24 depending on whether Florida's narrower law and laws not yet in force are counted) (verify with the IAPP tracker). They share a core: notice, access, deletion, correction, opt-out of sale, targeted advertising and profiling, limits on sensitive data, contracts between controllers and processors, and (in most) data protection assessments for risky processing.

What matters here:

1. **Caller Whale is a service provider / processor for its customers' lists.** In California a service provider may use personal information **internally to build or improve the quality of its services**, but not to perform services for another person, and the rules restrict building profiles for another business (Cal. Code Regs. tit. 11, § 7050) (verify the current text). Commentary on the rules differs on how far this goes.
2. **Pooling is the danger.** Using one customer's leads to give another customer feedback on its leads is "using personal information to perform services for another person", and it can turn into a **sale or share** in the statutes' meaning. Secondary sources stress that **hashed identifiers are still personal information**: hashing is not de-identification.
3. **A hash is pseudonymous, not anonymous.** Anyone holding a phone number can compute its hash with the key; whoever holds the key can match. The key's custody is therefore a security control, not a legal cure.

### Design rules that follow (now in force in the code and the screen)

- **Learning is per workspace, and the code enforces it.** What the store learns about a customer's leads is used only for that customer's own suggestions. The phone and email hashes use a key derived **per workspace**, so the same phone number has a different hash in every workspace and rows cannot be matched across workspaces even by mistake. (Today the only cross-workspace data is the count of what column titles mean, which has no personal data.)
- **Never sold, shared, licensed or given to anyone.** Not to customers, not to partners, not to advertisers. This also keeps Caller Whale out of the data-broker laws (next section).
- **No use for advertising, profiling people for others, or eligibility decisions.**
- **Contract first.** The customer terms and data processing agreement must state this use, name the limits above, and give the customer the opt-out. The CRM shows the choice to administrators (Settings, workspace).
- **Deletion works.** Opt-out, erase-person-everywhere and a two-year expiry exist; consumer requests that reach Caller Whale are answered with erase-everywhere (see section 8).

## 4. Data broker laws

California (the Delete Act and its DROP deletion platform, with brokers required to process deletion requests from **August 1, 2026**, fines of $200 per request per day, annual registration), Vermont, Texas, Oregon and others require data brokers to register and in some cases to honour deletion requests. The common core is a business that **collects and sells or licenses personal information of people it has no direct relationship with** (Vermont/Oregon; Texas phrases it as data the business "did not collect directly from the individual"; California's definition and regulations have widened, verify) (verify each definition and fee against the statute and the registry).

Caller Whale has no direct relationship with the people in the lists. It is **not a data broker only while it does not sell, license or transfer that data for value**. The rule "never sold, shared or licensed" above is what keeps it outside these laws; breaking it (for example selling insights about individuals) would require registration in several states and deletion handling for every request. An attorney should confirm the line, especially for **Texas** (broader) and **California** (a rule change could widen it).

## 5. Sector and local rules to confirm

- **State telemarketing and "mini-TCPA" laws** (several states in 2025 and 2026, including text-message rules; Florida, Oklahoma, Maryland and others) affect customers' calling, not the store; the CRM's calling features need their own check.
- **State laws on biometric, health and children's data**: not applicable unless uploaded; the terms forbid it.
- **Breach notification laws** (all 50 states) cover this database: it holds hashes and shapes, but a breach plan is still required.
- **Local laws** (for example city rules on data) and **state AI laws** (Colorado AI Act and similar) can apply to automated decisions about people; the store does not decide anything about a person, and that must stay true.

## 6. Where the store is weakest legally (honest list)

1. **Cross-customer learning is not safe to rely on.** The code and screen now say per workspace. Anything that mixes workspaces must first be shown to be aggregated and non-personal.
2. **Keeping the learned copy after a customer deletes** (the owner's wish) rests on Caller Whale's own purpose and needs a lawful basis, notice, and honest wording. A cautious reading is that on workspace closure the rows go (the opt-out already erases); keeping them needs the attorney's yes.
3. **The people in the lists cannot opt out themselves** except by asking Caller Whale or the customer. Several state laws require a way to reach Caller Whale directly. The notice must give one.
4. **Terms, notice and agreements are still drafts** (the site's privacy and terms pages are marked draft).
5. **Algorithmic disgorgement risk**: a model trained on data that was improperly obtained or used beyond what was disclosed can be ordered destroyed. Disclosure and consent come before training.

## 7. What a US privacy attorney must decide before the learning copy is relied on

1. Is Caller Whale a service provider/processor, a controller, or a data broker for this use, in California, Texas, Vermont, Oregon, and each state with a comprehensive law where customers operate?
2. Do the customer terms and DPA cover the use, and what must be added (purpose limits, per-workspace learning, no sale, deletion, assistance with requests)?
3. What the privacy notice and the "at collection" notice must say, and where; how a person reaches Caller Whale to be removed.
4. Whether the hashes count as de-identified under any statute (assume not). Hashes already use a per-workspace key, which stops cross-customer matching technically.
5. Data protection assessments required (Colorado, Virginia, Connecticut and others for profiling/sale/sensitive data) and what they must contain.
6. Retention (two years) and what happens on closure.
7. Whether anything about the **skip tracing**, **call history import** and **calling** features needs its own permissible-purpose or consent review (GLBA, DPPA, FCRA pretexting, TCPA, state laws).

## 8. Operations (built; the owner runs them)

- **Switch off:** `LEARNING_ENABLED=false` on the learning app, redeploy. Erasure and opt-out still work.
- **A person asks to be removed** (any customer's list): the owner calls `POST /v1/erase-everywhere` with the person's phone or email, using the learning token, from a machine on the private network (or the Coolify terminal of the learning app). Record the date of the request and the answer; the audit table keeps the count.
- **A customer opts out:** workspace administrators use Settings, workspace, "Improving Caller Whale with your lists".
- **Check it works:** `GET /v1/stats` (counts only) and the log lines `INFO copied import ... rows` in crm-core and `INFO POST /v1/ingest 200` in the learning app.
- **Key custody:** `LEARNING_HASH_KEY` backed up outside Coolify, held by two owners. Losing it breaks matching; leaking it weakens the pseudonymisation.

## Sources (researched 2026-11-10; secondary sources need verifying)

- California service-provider rule, Cal. Code Regs. tit. 11, § 7050: [vLex copy](https://regulations.vlex.com/vid/cal-code-regs-tit-958212738); commentary: [Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/california-attorney-general-ag-released-third-draft-of-proposed-ccpa-regs), [Cleary Gottlieb](https://www.clearygottlieb.com/news-and-insights/publication-listing/california-ag-proposes-modified-ccpa-regulations).
- State privacy law counts: [Multistate](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026), [Byte Back](https://www.bytebacklaw.com/2026/06/u-s-state-privacy-law-landscape-expands-to-24-states-what-the-latest-legislative-wave-means-for-businesses/); authoritative tracker: IAPP US State Privacy Legislation Tracker.
- Data brokers: [California Privacy Protection Agency, DROP](https://cppa.ca.gov/data_brokers), [privacy.ca.gov data brokers](https://privacy.ca.gov/data-brokers), [Cozen on Texas and Oregon](https://www.cozen.com/news-resources/publications/2024/new-data-broker-laws-in-texas-and-oregon), [state comparison](https://captaincompliance.com/education/state-data-broker-laws-compared-ct-ca-tx-vt-mt/), [Vermont Secretary of State](https://sos.vermont.gov/node/228).
- Hashed identifiers and selling/sharing: [Clym on sharing under the CCPA](https://www.clym.io/blog/what-counts-as-sharing-personal-information-under-the-ccpa), [National Law Review on de-identification](https://www.natlawreview.com/article/deidentification-silver-bullet-to-allowing-service-providers-to-use-personal).
- FTC model deletion: [CyberScoop](https://cyberscoop.com/ftc-algorithm-disgorgement-ai-regulation/), [Richmond JOLT](https://scholarship.richmond.edu/jolt/vol29/iss2/1).
- TCPA: [Kelley Drye on the 11th Circuit](https://www.kelleydrye.com/viewpoints/podcasts/ad-law-access/eleventh-circuit-vacates-tcpa-1-1-consent-rule), [Mondaq on the FCC removal](https://www.mondaq.com/unitedstates/telecoms-mobile-cable-communications/1654600/fcc-deletes-deletes-deletes-one-to-one-consent-tcpa-rule), [McGuireWoods](https://www.mcguirewoods.com/client-resources/alerts/2025/1/delayed-one-to-one-consent-rule-gives-companies-reprieve-plus-other-tcpa-updates/).
