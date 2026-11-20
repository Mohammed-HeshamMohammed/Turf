import type { CSSProperties } from "react";
import type { Me } from "@callerwhale/auth-client";
import { Link } from "./nav.tsx";
import { HeroSideTab } from "./Announcement.tsx";
import { STATUS, features } from "./content/features.ts";
import { Screen } from "./ui.tsx";

const words = ["Lists", "Skip tracing", "Calls", "Texts", "Leads map", "Deals", "Handoffs", "Reports", "Exports"];
const statement = "A list, a call, a follow-up and a deal belong to the same record. Caller Whale keeps the context with the work, instead of passing it between tools.".split(" ");
const steps = [
  { title: "Lists", text: "Import leads and keep the source intact.", shot: "lists", alt: "Source lists in Caller Whale with record and check status", to: "/features/import-lists" },
  { title: "Lead records", text: "Find the next step and the full history.", shot: "dashboard", alt: "The overview page with active leads, next steps and pipeline value", to: "/features/crm" },
  { title: "Calls", text: "Work the queue and record outcomes.", shot: "calls", alt: "The call queue with the lead and outcomes beside it", to: "/features/dialer-and-sms" },
  { title: "Handoffs", text: "Move a deal to the right teammate.", shot: "handoffs", alt: "Handoffs between teammates listed with their status", to: "/features/crm" },
  { title: "Reports", text: "See what moved forward and export your data.", shot: "reports", alt: "Reports showing what moved forward, with export options", to: "/features/exports" },
];
// Tiles that get more room in the grid, and the app screen shown in two of them.
const sizes: Record<string, string> = { "crm": " is-big", "dialer-and-sms": " is-wide", "skip-tracing": " is-wide has-shot", "backup-and-restore": " is-wide" };
const shots: Record<string, [string, string]> = { "crm": ["inbox", "The team inbox, with each conversation beside its lead."], "skip-tracing": ["skip", "The Skip Tracing page showing detected source fields, the evidence order and the check context."] };
const facts = [
  ["8", "features, each priced on its own"],
  ["50 MB", "per CSV import, every row kept"],
  ["Offline", "lists live on your computer"],
  ["$0", "to export your data, any time"],
];
// The CRM leads the grid: it is the tile the others plug into.
const tiles = [...features].sort((a, b) => Number(b.slug === "crm") - Number(a.slug === "crm"));
const i = (n: number) => ({ "--i": n }) as CSSProperties;
const Arrow = () => <span aria-hidden="true">→</span>;

/** The public home page: hero, then the story told in scrolling sections. Every claim comes from content/features.ts. */
export function Home({ me, authBase }: { me: Me | null | undefined; authBase: string }) {
  const line = <span>{words.map(word => <b key={word}>{word}<i aria-hidden="true">/</i></b>)}</span>;
  return <>
    <section className="hero-banner hm-hero">
      <img className="hm-hero-bg" src="/hero.webp" alt="" fetchPriority="high" />
      <div className="hm-hero-main">
        <h1>Every lead has<br />a next call</h1>
        <div className="actions">
          {me !== undefined && <Link className="hm-go" to={me ? "/account" : "/signup"}>{me ? "Open your profile" : "Start calling free"} <Arrow /></Link>}
          <Link className="hm-link" to="/features">Explore features</Link>
        </div>
      </div>
      <div className="hm-hero-side">
        <p>Lists, calls, deal notes and team handoffs in one workspace, so you always know what to do next.</p>
      </div>
      {me === null && <HeroSideTab authBase={authBase} />}
    </section>

    <section className="hm-dark hm-bleed" aria-labelledby="hm-why">
      <div className="hm-marquee" aria-hidden="true"><div>{line}{line}</div></div>
      <div className="hm-wrap hm-statement">
        <h2 id="hm-why">{statement.map((word, n) => <span key={n} style={i(n)}>{word} </span>)}</h2>
        <Link className="hm-link" to="/why-caller-whale">Why keep it together <Arrow /></Link>
      </div>
    </section>

    <section className="hm-flow" aria-labelledby="hm-flow-title">
      <header className="hm-head"><h2 id="hm-flow-title">One flow, from list<br />to closed deal</h2></header>
      <ol className="hm-steps">{steps.map((step, n) => <li className="hm-step" key={step.title} style={i(n)}>
        <div className="hm-step-copy"><span className="hm-num">{n + 1}</span><h3>{step.title}</h3><p>{step.text}</p><Link className="hm-link" to={step.to}>See how <Arrow /></Link></div>
        <Screen file={step.shot} alt={step.alt} />
      </li>)}</ol>
    </section>

    <section className="hm-features" aria-labelledby="hm-features-title">
      <header className="hm-head"><h2 id="hm-features-title">Everything a lead<br />goes through</h2><p>Eight features, each priced on its own. Every one is marked with what works today and what is coming.</p></header>
      <ul className="hm-bento">
        {tiles.map(f => <li key={f.slug} className={`hm-tile${sizes[f.slug] || ""}`}><Link to={`/features/${f.slug}`}>
          <h3>{f.title}</h3>
          <p>{f.short}</p>
          <span className={`hm-status is-${f.status}`}>{STATUS[f.status]}</span>
          {shots[f.slug] && <Screen file={shots[f.slug][0]} alt={shots[f.slug][1]} />}
        </Link></li>)}
        <li className="hm-tile is-wide is-accent"><Link to="/features"><h3>See all eight, side by side</h3><p>What each one does, and how far along it is.</p></Link></li>
      </ul>
    </section>

    <section className="hm-dark hm-facts" aria-label="Caller Whale in numbers">
      <dl>{facts.map(([big, small]) => <div key={big}><dt>{big}</dt><dd>{small}</dd></div>)}</dl>
    </section>

    <section className="hm-cta" aria-labelledby="hm-cta-title">
      <h2 id="hm-cta-title">Build a plan around your work</h2>
      <p>Choose the features your team needs and see the draft monthly total as you go.</p>
      <div className="actions">
        <Link className="hm-go is-dark" to="/pricing">Explore pricing <Arrow /></Link>
        {me === null && <Link className="hm-link" to="/signup">Start calling free</Link>}
      </div>
    </section>
  </>;
}
