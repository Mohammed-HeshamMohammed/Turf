import { Fragment, useState } from "react";
import {
  audiences, compareRows, features, priceRows, principles, securityPoints, steps, tiers,
} from "./content.js";
import { PlanBuilder } from "./PlanBuilder.jsx";
import { ALL_IN, MORE_PLANS, quote, summarize, tierPrice } from "./plan.js";
import { Badge, ContactForm, Faq, FinalCta, Icon, PageHead, Reveal, Shot } from "./components.jsx";

const money = n => `$${n.toLocaleString("en-US")}`;

export function Home({ onPick }) {
  const tour = ["crm", "skip", "map", "dialer"].map(id => features.find(f => f.id === id));
  return (
    <>
      <section className="hero" id="top">
        <p className="eyebrow">CRM and dialer for property outreach</p>
        <h1>From a raw list to a closed deal, in one app.</h1>
        <p className="lead">
          Import lists, skip trace the owners, call and text them, and track every deal. Turf is a desktop CRM that keeps
          working when your connection does not.
        </p>
        <div className="actions">
          <a className="button" href="/#waitlist">Join the waitlist</a>
          <a className="button ghost" href="/features">See every feature</a>
        </div>
        <ul className="hero-points" aria-label="Highlights">
          <li>Works offline</li>
          <li>Original data never changed</li>
          <li>Clients are free seats</li>
        </ul>
        <Shot file="calls" alt="The Calls page: a call queue, the lead being called with the phone number and Start call button, and the call assistant." eager />
      </section>

      <section className="section strip" aria-label="The old way and Turf">
        <Reveal className="old-new">
          <div>
            <h2>Five subscriptions, or one app.</h2>
            <p className="sub">A list tool, a skip-tracing service, a dialer, a texting tool and a CRM, with you copying results between them.</p>
          </div>
          <ul className="chips" aria-label="What Turf replaces">
            {["Lists", "Skip tracing", "Dialer", "Texting", "CRM"].map(c => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <a className="button ghost small" href="/compare">See the difference</a>
        </Reveal>
      </section>

      <section className="section">
        <h2>Everything a lead goes through</h2>
        <ul className="grid four">
          {features.map((f, i) => (
            <Reveal as="li" className="card" key={f.id} style={{ transitionDelay: `${(i % 4) * 60}ms` }}>
              <Icon name={f.icon} />
              <h3>{f.title}</h3>
              <p>{f.short}</p>
              <Badge status={f.status} />
              <a className="more" href={`/features#${f.id}`}>Learn more</a>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className="section band" aria-labelledby="see">
        <h2 id="see">See it working</h2>
        <p className="sub">Real screens from the app, with sample data.</p>
        <div className="tour">
          {tour.map((f, i) => (
            <Reveal className={`tour-item ${i % 2 ? "flip" : ""}`} key={f.id}>
              <div className="tour-copy">
                <h3>{f.pitch}</h3>
                <p>{f.text}</p>
                <a className="more" href={`/features#${f.id}`}>About {f.title.toLowerCase()}</a>
              </div>
              <Shot file={f.shot} alt={f.alt} />
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="how">
        <h2 id="how">How it works</h2>
        <ol className="steps">
          {steps.map((s, i) => (
            <Reveal as="li" key={s.title}>
              <span className="num">{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </Reveal>
          ))}
        </ol>
        <ul className="grid three principles">
          {principles.map(p => (
            <li key={p.title}>
              <Icon name={p.icon} />
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section band">
        <h2>Built for people who work property leads</h2>
        <ul className="grid three">
          {audiences.map(a => (
            <Reveal as="li" className="card" key={a.title}>
              <h3>{a.title}</h3>
              <p>{a.text}</p>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className="section" id="plans">
        <h2>A plan for how you work</h2>
        <p className="sub">Draft launch prices. Each feature is priced on its own, and a plan is the sum.</p>
        <ul className="grid four">
          {tiers.filter(t => t.id !== "trial").map(t => (
            <li className="card" key={t.id}>
              <h3>{t.name}</h3>
              <p className="who">{t.who}</p>
              <p className="price">{money(tierPrice(t.id).price)}<span> / {t.unit}</span></p>
              {tierPrice(t.id).from && <p className="fine">from {money(tierPrice(t.id).from)} a month for 3 seats</p>}
              {tierPrice(t.id).list > tierPrice(t.id).price && <p className="fine">One by one it would be {money(tierPrice(t.id).list)}. Together they cost less.</p>}
              {t.includes && (
                <ul className="ticks small">
                  {t.includes.map(i => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              <p>{t.text}</p>
              <a className="button ghost small" href="/#waitlist" onClick={() => onPick(t.id)}>I want {t.name}</a>
            </li>
          ))}
        </ul>
        <p className="fine center-text"><a href="/pricing">Compare every feature and limit</a></p>
      </section>

      <Faq />
    </>
  );
}

export function Features() {
  return (
    <>
      <PageHead
        eyebrow="Features"
        title="Everything a lead goes through."
        lead="Eight features, each priced on its own. Every one is marked with what works today and what is coming."
      />
      <nav className="jump" aria-label="Jump to a feature">
        {features.map(f => (
          <a key={f.id} href={`/features#${f.id}`}>{f.title}</a>
        ))}
      </nav>
      {features.map((f, i) => (
        <section className={`section feature ${i % 2 ? "band" : ""}`} id={f.id} key={f.id}>
          <Reveal className={`feature-grid ${i % 2 ? "flip" : ""}`}>
            <div className="feature-copy">
              <div className="feature-title">
                <Icon name={f.icon} size={26} />
                <Badge status={f.status} />
              </div>
              <h2>{f.title}</h2>
              <p className="pitch">{f.pitch}</p>
              <p>{f.text}</p>
              <ul className="ticks">
                {f.points.map(p => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {f.soon && (
                <div className="soon">
                  <h3>Coming at launch</h3>
                  <ul>
                    {f.soon.map(p => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="feature-shots">
              <Shot file={f.shot} alt={f.alt} />
              {f.extra?.map(e => (
                <Shot key={e.shot} file={e.shot} alt={e.alt} />
              ))}
            </div>
          </Reveal>
        </section>
      ))}
      <FinalCta />
    </>
  );
}

export function Pricing({ onPick }) {
  const cols = tiers;
  // "Customize" on a plan card loads it into the builder (a new key remounts the builder with that selection).
  const [seed, setSeed] = useState({ n: 0, selection: null });
  return (
    <>
      <PageHead
        eyebrow="Pricing"
        title="Build the plan you need."
        lead="Switch features on and off and pay only for what you use. The ready-made plans are just starting points. These are draft launch prices and may change before launch. Checkout is not open yet."
      />
      <section className="section" id="builder">
        <PlanBuilder key={seed.n} initial={seed.selection} onChoose={onPick} />
      </section>

      <section className="section band">
        <h2>Or start from a ready-made plan</h2>
        <p className="sub">Every feature switched on, at the level that fits your team. The CRM is included.</p>
        <ul className="grid four">
          {tiers.filter(t => t.id !== "trial").map(t => (
            <Reveal as="li" className="card" key={t.id}>
              <h3>{t.name}</h3>
              <p className="who">{t.who}</p>
              <p className="price">{money(tierPrice(t.id).price)}<span> / {t.unit}</span></p>
              {tierPrice(t.id).from && <p className="fine">from {money(tierPrice(t.id).from)} a month for 3 seats</p>}
              {tierPrice(t.id).list > tierPrice(t.id).price && <p className="fine">One by one it would be {money(tierPrice(t.id).list)}. Together they cost less.</p>}
              {t.includes && (
                <ul className="ticks small">
                  {t.includes.map(i => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              <p>{t.text}</p>
              <a className="button small" href="#waitlist" onClick={() => onPick(t.id)}>Join the waitlist for {t.name}</a>
            </Reveal>
          ))}
        </ul>
      </section>

      <section className="section" id="more-plans">
        <h2>More plans for how you work</h2>
        <p className="sub">Not everyone needs everything. The CRM is included in every plan. Start from the one closest to you, then change it in the builder.</p>
        <ul className="grid three plan-cards">
          {MORE_PLANS.map(p => {
            const q = quote(p.selection);
            const on = q.lines.filter(l => l.level !== "off");
            return (
              <Reveal as="li" className="card" key={p.id}>
                <h3>{p.name}</h3>
                <p className="who">{p.who}</p>
                <p className="price">{money(q.total)}<span> / month{q.seats > 1 ? ` for ${q.seats}` : ""}</span></p>
                <p>{p.text}</p>
                <ul className="chips" aria-label="Included features">
                  {on.map(l => (
                    <li key={l.id}>
                      {l.name}
                      {l.level === "power" ? " (Power)" : ""}
                      {l.people !== q.seats ? ` · ${l.people} ${l.people === 1 ? "person" : "people"}` : ""}
                    </li>
                  ))}
                </ul>
                {q.readyMade > q.total && <p className="fine">{money(q.readyMade - q.total)} less than every feature for {q.seats === 1 ? "one person" : `${q.seats} people`}.</p>}
                <div className="card-actions">
                  <a className="button small" href="#builder" onClick={() => setSeed({ n: seed.n + 1, selection: p.selection })}>Customize</a>
                  <a className="button ghost small" href="#waitlist" onClick={() => onPick("custom", summarize(p.selection, p.name))}>Join the waitlist</a>
                </div>
              </Reveal>
            );
          })}
        </ul>
      </section>

      <section className="section band">
        <h2>What is in each plan</h2>
        <p className="sub">Price per month, with what that includes. Seat prices are per person.</p>
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th scope="col">Feature</th>
                {cols.map(t => (
                  <th scope="col" key={t.id}>{t.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {priceRows.map(r => (
                <tr key={r.feature}>
                  <th scope="row">{r.feature}</th>
                  {r.values.map((v, i) => (
                    <td key={cols[i].id} data-label={cols[i].name}>
                      <strong>{v}</strong>
                      {r.limits[i] && <span>{r.limits[i]}</span>}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="list">
                <th scope="row">Features one by one</th>
                {cols.map(t => (
                  <td key={t.id} data-label={t.name}>{tierPrice(t.id).list ? money(tierPrice(t.id).list) : "Free"}</td>
                ))}
              </tr>
              <tr className="total">
                <th scope="row">All-in price</th>
                {cols.map(t => (
                  <td key={t.id} data-label={t.name}>
                    <strong>{tierPrice(t.id).price ? money(tierPrice(t.id).price) : "Free"}</strong>
                    {tierPrice(t.id).from && <span>from {money(tierPrice(t.id).from)} for 3 seats</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <ul className="fine-list">
          <li>All-in price: however many features one person switches on, they pay at most {money(ALL_IN.solo)} a month for them. Teams get a cap per person.</li>
          <li>The all-in price lowers the software part only. Calling, texts, numbers, number lookups and campaign emails cost us money to provide, so they are priced close to cost and never discounted.</li>
          <li>Clients and partners you share properties with are free seats in every plan.</li>
          <li>Processing lists on your computer, including import, merge and skip tracing, is not counted against your plan.</li>
          <li>Calling is unlimited, subject to fair use. Texts are flexible: the amount shown is included, and more are $15 per 1,000. Dialer prices are for the single-line Power dialer, except Pro, which adds multi-line dialing and voicemail drop.</li>
          <li>Payment fees, sales tax and annual discounts are settled before checkout opens.</li>
        </ul>
      </section>
      <Faq />
    </>
  );
}

export function Compare() {
  return (
    <>
      <PageHead
        eyebrow="Why Turf"
        title="One app instead of five."
        lead="Most property teams stitch together a list tool, a skip-tracing service, a dialer, a texting tool and a CRM. Turf does the work of all five in one place."
      />
      <section className="section">
        <div className="table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">What you need</th>
                <th scope="col">The usual way</th>
                <th scope="col" className="turf-col">With Turf</th>
              </tr>
            </thead>
            <tbody>
              {compareRows.map(r => (
                <tr key={r.need}>
                  <th scope="row">{r.need}</th>
                  <td data-label="The usual way">{r.usual}</td>
                  <td data-label="With Turf" className="turf-col">{r.turf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="section band">
        <h2>Where Turf is honest about its limits</h2>
        <ul className="grid three">
          <li className="card">
            <h3>It does not find new numbers yet</h3>
            <p>Turf cleans and ranks the numbers your list has. Looking up new ones is planned as a separate service.</p>
          </li>
          <li className="card">
            <h3>It is not live at scale yet</h3>
            <p>Established dialers have years of proven calling at call-center size. Turf is new, and live calling is a launch feature.</p>
          </li>
          <li className="card">
            <h3>Windows first</h3>
            <p>The desktop app runs on Windows. Other systems come later.</p>
          </li>
        </ul>
      </section>
      <FinalCta />
    </>
  );
}

export function Security() {
  return (
    <>
      <PageHead
        eyebrow="Security"
        title="Your records stay yours."
        lead="What protects your accounts and data, and which parts are built today and which are still coming."
      />
      <section className="section">
        <ul className="grid three">
          {securityPoints.map(p => (
            <Reveal as="li" className="card" key={p.title}>
              <Icon name={p.icon} />
              <h3>{p.title}</h3>
              <p>{p.text}</p>
              <Badge status={p.status} />
            </Reveal>
          ))}
        </ul>
      </section>
      <section className="section band">
        <h2>Original data is never changed</h2>
        <p className="sub">
          Skip tracing adds columns and answers beside your values. Every list can be downloaded as it was imported or as it
          is after checking, at any time.
        </p>
      </section>
      <FinalCta />
    </>
  );
}

export function Contact() {
  return (
    <>
      <PageHead eyebrow="Contact" title="Questions? Ask us." lead="We read every message and reply by email." />
      <section className="section">
        <ContactForm />
      </section>
      <Faq />
    </>
  );
}

const LEGAL = {
  privacy: {
    title: "Privacy",
    body: [
      "This site stores the details you give us in the waitlist and contact forms: your email address, and your name, company and message if you add them. We use them only to reply to you and to tell you about the launch.",
      "We count how many times each page is viewed, per day. That count has no cookie, no address, no device details and nothing that identifies you, and it is not sent when your browser says Do Not Track. We use no advertising trackers, so there is no cookie banner.",
      "We do not sell this information.",
      "To have your details removed, write to us through the contact form and we will delete them.",
    ],
  },
  terms: {
    title: "Terms",
    body: [
      "This site describes a product that has not launched. Features and plans described here may change before launch.",
      "Joining the waitlist is not a purchase and does not oblige you or us to anything.",
      "Terms of service for the product itself will be published before it is sold.",
    ],
  },
};

export const legalPages = Object.keys(LEGAL);

export function Legal({ page }) {
  const doc = LEGAL[page];
  return (
    <section className="section legal">
      <a href="/">← Back to the site</a>
      <h1>{doc.title}</h1>
      <p className="draft">Draft for launch. To be reviewed before the product is sold.</p>
      {doc.body.map(t => (
        <Fragment key={t}>
          <p>{t}</p>
        </Fragment>
      ))}
    </section>
  );
}

export function NotFound() {
  return (
    <section className="section legal">
      <h1>That page does not exist.</h1>
      <p>The link may be old or mistyped.</p>
      <p><a className="button" href="/">Go to the home page</a></p>
    </section>
  );
}
