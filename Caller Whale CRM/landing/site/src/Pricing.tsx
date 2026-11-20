import { useState } from "react";
import { Link } from "./nav.tsx";
import { PlanBuilder } from "./pricing/PlanBuilder.tsx";
import { faqs, priceRows, tiers } from "./pricing/content.ts";
import { ALL_IN, MORE_PLANS, quote, tierPrice, type Selection } from "./pricing/plan.ts";


const money = (n: number) => `$${n.toLocaleString("en-US")}`;

function PageHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <header className="page-head">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p className="lead">{lead}</p>
    </header>
  );
}

function Faq() {
  return (
    <section className="section band" aria-labelledby="faq-title">
      <h2 id="faq-title">Questions</h2>
      <div className="faq">
        {faqs.map(({ q, a }) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Pricing() {
  const cols = tiers;
  // "Customize" on a plan card loads it into the builder (a new key remounts the builder with that selection).
  const [seed, setSeed] = useState<{ n: number; selection: Selection | null }>({ n: 0, selection: null });
  return (
    <>
      <PageHead
        eyebrow="Pricing"
        title="Build the plan you need."
        lead="Switch features on and off and pay only for what you use. The ready-made plans are just starting points. These are draft launch prices and may change before launch. Checkout is not open yet."
      />
      <section className="section" id="builder">
        <PlanBuilder key={seed.n} initial={seed.selection} />
      </section>

      <section className="section band">
        <h2>Or start from a ready-made plan</h2>
        <p className="sub">Every feature switched on, at the level that fits your team. The CRM is included.</p>
        <ul className="grid four">
          {tiers
            .filter(t => t.id !== "trial")
            .map(t => (
              <li className="card" key={t.id}>
                <h3>{t.name}</h3>
                <p className="who">{t.who}</p>
                <p className="price">
                  {money(tierPrice(t.id).price)}
                  <span> / {t.unit}</span>
                </p>
                {tierPrice(t.id).from && <p className="fine">from {money(tierPrice(t.id).from ?? 0)} a month for 3 seats</p>}
                {tierPrice(t.id).list > tierPrice(t.id).price && <p className="fine">One by one it would be {money(tierPrice(t.id).list)}. Together they cost less.</p>}
                {t.includes && (
                  <ul className="ticks small">
                    {t.includes.map(i => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
                <p>{t.text}</p>
                <Link className="button primary tier-cta" to="/signup">Get started with {t.name}</Link>
              </li>
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
              <li className="card" key={p.id}>
                <h3>{p.name}</h3>
                <p className="who">{p.who}</p>
                <p className="price">
                  {money(q.total)}
                  <span> / month{q.seats > 1 ? ` for ${q.seats}` : ""}</span>
                </p>
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
                  <a
                    className="button small"
                    href="#builder"
                    onClick={() => setSeed({ n: seed.n + 1, selection: p.selection })}
                  >
                    Customize
                  </a>
                </div>
              </li>
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
                    {tierPrice(t.id).from && <span>from {money(tierPrice(t.id).from ?? 0)} for 3 seats</span>}
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
