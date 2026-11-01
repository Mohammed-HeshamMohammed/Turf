import { Fragment, useState } from "react";
import {
  compareRows, features, priceRows, securityPoints, tiers,
} from "./content.js";
import { PlanBuilder } from "./PlanBuilder.jsx";
import { ALL_IN, MORE_PLANS, quote, summarize, tierPrice } from "./plan.js";
import { Badge, ContactForm, Faq, FinalCta, Icon, PageHead, Reveal, Shot } from "./components.jsx";

const money = n => `$${n.toLocaleString("en-US")}`;

export function Home() {
  return (
    <div className="studio-home">
      <section className="studio-hero" id="top" aria-labelledby="home-title">
        <picture className="property-hero">
          <source
            media="(max-width: 600px)"
            srcSet="/images/property-hero-mobile.webp"
          />
          <img
            src="/images/property-hero.webp"
            width="1536"
            height="1024"
            alt="Contemporary residential rooflines in warm afternoon light; an illustrative property scene."
            fetchPriority="high"
          />
        </picture>
        <div className="hero-copy">
          <p className="studio-label">Built for property outreach</p>
          <h1 id="home-title">
            Your lists.
            <br />
            Your next
            <br />
            conversation.
          </h1>
          <p className="studio-lead">
            Organize property lists, review phone evidence and keep every
            follow-up in view.
          </p>
          <div className="actions">
            <a className="button" href="/#workflow">
              Explore the workflow <Icon name="ArrowRight" size={18} />
            </a>
            <a className="studio-link" href="/#workspace">
              See the desktop app
            </a>
          </div>
        </div>
      </section>

      <section
        className="studio-workflow"
        id="workflow"
        aria-label="The outreach workflow"
      >
        <ol>
          {[
            ["Import lists", "Bring your property records into one workspace."],
            [
              "Review numbers",
              "Review and rank the phone evidence you already have.",
            ],
            [
              "Prepare calls",
              "Keep context close. Live calling is not available yet.",
            ],
            [
              "Track follow-ups",
              "Record outcomes and give the next step an owner.",
            ],
          ].map(([title, text], i) => (
            <li key={title}>
              <span className="studio-label">0{i + 1}</span>
              <div>
                <h2>{title}</h2>
                <p>{text}</p>
              </div>
              <Icon name="ArrowRight" size={22} />
            </li>
          ))}
        </ol>
      </section>

      <section className="studio-section workspace-proof" id="workspace">
        <div className="proof-copy">
          <p className="studio-label">The workspace behind the outreach</p>
          <h2>Keep the conversation and the next step together.</h2>
          <ul className="proof-points">
            {[
              [
                "A list with context.",
                "See property details, notes and prior activity before you call.",
              ],
              [
                "A conversation with history.",
                "Review call outcomes alongside the record they belong to.",
              ],
              [
                "A follow-up with an owner.",
                "Record the next step and hand work over with context.",
              ],
            ].map(([title, text]) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </div>
        <figure className="product-evidence">
          <a
            href="/screens/calls.webp"
            target="_blank"
            rel="noreferrer"
            aria-label="Open full-size Calls sample workspace screenshot"
          >
            <img
              src="/screens/calls.webp"
              width="1440"
              height="900"
              alt="Caller Whale sample Calls workspace with a queue, call history and follow-up controls."
              loading="lazy"
            />
          </a>
          <figcaption>
            Sample workspace · calling preview.{" "}
            <a href="/screens/calls.webp" target="_blank" rel="noreferrer">
              View full size
            </a>
          </figcaption>
        </figure>
      </section>

      <section className="studio-stories" aria-label="From property data to the next conversation">
        <div className="stories-intro"><p className="studio-label">Less sorting. More meaningful conversations.</p><h2>A clearer path<br />from list to next step.</h2></div>
        {[
          {
            number: "01", label: "From scattered to sorted",
            title: "A messy list.\nA clear place to start.",
            text: "Turn scattered property records into a list you can work with. Map the columns, review the numbers you already have and see the context behind the next conversation.",
            detail: "Review supplied phone evidence. New-number discovery is planned.",
            image: "data-to-order", alt: "Scattered paper records give way to an ordered row of miniature property models.",
            signals: ["Import your list", "Review the evidence", "Choose the next call"],
            badge: "A little order goes a long way", icon: "ListChecks", anchor: "skip",
          },
          {
            number: "02", label: "A little help in the conversation",
            title: "Less searching.\nMore listening.",
            text: "Keep the lead’s details, call notes and useful prompts close at hand. The calling preview brings the conversation and its context together, so you can focus on what is being said.",
            detail: "Call assistance is shown in preview. Live telephony is not available yet.",
            image: "call-assistance", alt: "A charcoal phone handset, a miniature house and a calm arrangement of context cards.",
            signals: ["Lead context", "Useful prompts", "A clear outcome"],
            badge: "The right context, close at hand", icon: "Phone", anchor: "dialer",
          },
          {
            number: "03", label: "Keep the momentum",
            title: "A conversation ends.\nThe context stays.",
            text: "Leave a note, set a callback and keep the next step connected to the property. When work changes hands, the story can go with it.",
            detail: "Team handoffs and role-based workflows are demonstrated in the sample workspace.",
            image: "follow-through", alt: "Miniature houses along connected platforms, with one completed step and another waiting ahead.",
            signals: ["Record the outcome", "Set the follow-up", "Pass on the context"],
            badge: "Every next step has a place", icon: "Users", anchor: "crm",
          },
        ].map(story => (
          <article className={`studio-story story-${story.number}`} key={story.number}>
            <div className="story-copy">
              <p className="studio-label">{story.number} / {story.label}</p>
              <h2>{story.title.split("\n").map((line, index) => <Fragment key={line}>{index > 0 && <br />}{line}</Fragment>)}</h2>
              <p>{story.text}</p>
              <a className="studio-link" href={`/features#${story.anchor}`}>Explore the feature <Icon name="ArrowUpRight" size={18} /></a>
              <p className="story-detail">{story.detail}</p>
            </div>
            <figure className="benefit-scene">
              <div className="scene-art">
                <img src={`/images/${story.image}.webp`} width="1536" height="1024" alt={story.alt} loading="lazy" decoding="async" />
                <div className="scene-badge"><Icon name={story.icon} size={18} /><span>{story.badge}</span></div>
              </div>
              <figcaption className="scene-steps">{story.signals.map((signal,index) => <span key={signal}><span className="scene-step-number">0{index+1}</span>{signal}</span>)}</figcaption>
            </figure>
          </article>
        ))}
      </section>

      <section className="studio-section studio-people">
        <div>
          <p className="studio-label">One person. Or the next person.</p>
          <h2>
            A clear next step,
            <br />
            whoever owns it.
          </h2>
          <p className="story-detail">
            Individual list work today. Team roles and handoffs shown in
            preview.
          </p>
        </div>
        <ul>
          {[
            [
              "Solo operator",
              "Keep your lists, notes and callbacks in one desktop workspace.",
            ],
            [
              "Caller",
              "Review the lead’s context and record the outcome of the conversation.",
            ],
            [
              "Closer & team",
              "Review handoff context and the work that needs attention next.",
            ],
          ].map(([title, text]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="studio-section studio-continuity">
        <p className="studio-label">Your records. Still yours.</p>
        <div>
          <h2>
            Keep the original.
            <br />
            Carry the work forward.
          </h2>
          <p>
            Work with local lists and exports on your desktop. Signing in, team
            sync and online services need a connection; not every operation
            works offline.
          </p>
          <a className="studio-link" href="/security">
            Data and security <Icon name="ArrowUpRight" size={18} />
          </a>
        </div>
      </section>

      <section className="studio-section studio-pricing" id="plans">
        <div>
          <p className="studio-label">A plan around the work</p>
          <h2>
            Choose the tools
            <br />
            your work needs.
          </h2>
        </div>
        <div>
          <p>
            Start with the CRM base, configure features and choose the people
            who need them. Explore the existing plan builder to see how the
            pieces fit.
          </p>
          <p className="story-detail">
            Draft launch pricing. Checkout and automatic activation are not
            available.
          </p>
          <a className="button" href="/pricing">
            Build your plan <Icon name="ArrowRight" size={18} />
          </a>
        </div>
      </section>
      <Faq />
    </div>
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
        eyebrow="Why Caller Whale"
        title="One app instead of five."
        lead="Most property teams stitch together a list tool, a skip-tracing service, a dialer, a texting tool and a CRM. Caller Whale does the work of all five in one place."
      />
      <section className="section">
        <div className="table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">What you need</th>
                <th scope="col">The usual way</th>
                <th scope="col" className="callerwhale-col">With Caller Whale</th>
              </tr>
            </thead>
            <tbody>
              {compareRows.map(r => (
                <tr key={r.need}>
                  <th scope="row">{r.need}</th>
                  <td data-label="The usual way">{r.usual}</td>
                  <td data-label="With Caller Whale" className="callerwhale-col">{r.callerwhale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="section band">
        <h2>Where Caller Whale is honest about its limits</h2>
        <ul className="grid three">
          <li className="card">
            <h3>It does not find new numbers yet</h3>
            <p>Caller Whale cleans and ranks the numbers your list has. Looking up new ones is planned as a separate service.</p>
          </li>
          <li className="card">
            <h3>It is not live at scale yet</h3>
            <p>Established dialers have years of proven calling at call-center size. Caller Whale is new, and live calling is a launch feature.</p>
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
      <section className="section contact">
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
    <>
      <PageHead title="That page does not exist." lead="The link may be old or mistyped." />
      <section className="section missing">
        <a className="button" href="/">Go to the home page</a>
      </section>
    </>
  );
}
