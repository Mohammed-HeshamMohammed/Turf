import { useEffect, useRef, useState } from "react";
import {
  Archive, Buildings, Circle, CreditCard, DeviceMobile, Export, GoogleLogo, HardDrives, IdentificationBadge, Kanban,
  ListChecks, LockKey, MagnifyingGlass, MapTrifold, Phone, ShieldCheck, Sparkle, UploadSimple, Users, WifiSlash,
} from "@phosphor-icons/react";
import { STATUS, faqs, footerLinks, tiers } from "./content.js";
import { getDownload, joinWaitlist, sendMessage } from "./api.js";

const ICONS = {
  Archive, Buildings, CreditCard, DeviceMobile, Export, GoogleLogo, HardDrives, IdentificationBadge, Kanban,
  ListChecks, LockKey, MagnifyingGlass, MapTrifold, Phone, ShieldCheck, Sparkle, UploadSimple, Users, WifiSlash,
};

export const Icon = ({ name, size = 22 }) => {
  const Component = ICONS[name] || Circle;
  return <Component size={size} weight="duotone" aria-hidden="true" />;
};

const SIGN_IN_URL = import.meta.env.VITE_TURF_SIGNUP_URL || "";

/** Fades a block in once as it scrolls into view. Without motion preference, or without IntersectionObserver, it just shows. */
export function Reveal({ children, as: Tag = "div", className = "", ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} className={`reveal ${shown ? "in" : ""} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function Badge({ status }) {
  return <span className={`badge ${status}`}>{STATUS[status]}</span>;
}

export function Shot({ file, alt, eager, tilt }) {
  return (
    <figure className={`shot ${tilt ? "tilt" : ""}`}>
      <div className="bar" aria-hidden="true"><i /><i /><i /></div>
      <img src={`/screens/${file}.webp`} width="1440" height="900" alt={alt} decoding="async" />
    </figure>
  );
}

export function Header({ route }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);
  const links = [["features", "Features"], ["pricing", "Pricing"], ["compare", "Why Turf"], ["security", "Security"]];
  return (
    <header className="top">
      <a className="brand" href="/" aria-label="Turf home">
        <span className="logo" aria-hidden="true">T</span>
        Turf
      </a>
      <button className="menu-toggle" aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>
        {open ? "Close" : "Menu"}
      </button>
      <nav id="site-nav" aria-label="Site" className={open ? "open" : ""}>
        {links.map(([id, label]) => (
          <a key={id} href={`/${id}`} aria-current={route === id ? "page" : undefined}>{label}</a>
        ))}
        {SIGN_IN_URL && <a href={SIGN_IN_URL}>Sign in</a>}
        <a className="button small" href="/#waitlist">Join the waitlist</a>
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-main">
        <div className="foot-brand">
          <a className="brand" href="/"><span className="logo" aria-hidden="true">T</span>Turf</a>
          <p>The CRM and dialer for property outreach. Works offline, on your desktop.</p>
        </div>
        {footerLinks.map(col => (
          <nav key={col.title} aria-label={col.title}>
            <h3>{col.title}</h3>
            <ul>
              {col.links.map(([label, href]) => (
                <li key={label}><a href={href}>{label}</a></li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="foot-base">
        <span>© {new Date().getFullYear()} Turf. All rights reserved.</span>
        <span>Records stay on your machine and your organization's server.</span>
      </div>
    </footer>
  );
}

export function PageHead({ eyebrow, title, lead }) {
  return (
    <section className="page-head">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
    </section>
  );
}

export function Faq() {
  return (
    <section id="faq" className="section band">
      <h2>Questions people ask</h2>
      <div className="faq">
        {faqs.map(f => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <Reveal as="section" className="cta">
      <h2>Ready to work your next list in Turf?</h2>
      <p>Join the waitlist and be first in when the doors open.</p>
      <a className="button light" href="/#waitlist">Join the waitlist</a>
    </Reveal>
  );
}

export function Download() {
  const [release, setRelease] = useState(null);
  useEffect(() => {
    let live = true;
    getDownload()
      .then(r => live && setRelease(r))
      .catch(() => live && setRelease({ available: false }));
    return () => {
      live = false;
    };
  }, []);
  const mb = release?.size ? ` · ${(release.size / 1048576).toFixed(0)} MB` : "";
  return (
    <section id="download" className="section band center">
      <h2>Download for Windows</h2>
      {release?.available ? (
        <>
          <p className="sub">Version {release.version}{mb}</p>
          <a className="button" href={release.url}>Download Turf</a>
        </>
      ) : (
        <p className="sub">
          {release ? "The first release is coming soon. Join the waitlist and we will tell you." : "Checking for the latest version…"}
        </p>
      )}
    </section>
  );
}

function useForm(initial, submit) {
  const [form, setForm] = useState(initial);
  const [state, setState] = useState({ status: "idle", message: "" });
  const set = key => e => setForm({ ...form, [key]: e.target.value });
  async function onSubmit(e) {
    e.preventDefault();
    setState({ status: "sending", message: "" });
    try {
      setState({ status: "done", message: await submit(form) });
    } catch (err) {
      setState({ status: "error", message: err.message });
    }
  }
  return { form, set, state, onSubmit, setForm };
}

export function Waitlist({ tier, plan, setTier }) {
  const { form, set, state, onSubmit } = useForm({ email: "", name: "", company: "", website: "" }, async f => {
    const r = await joinWaitlist({ ...f, tier, plan: tier === "custom" ? plan : "" });
    return r.joined ? "You are on the list. We will email you at launch." : "You were already on the list.";
  });
  return (
    <section id="waitlist" className="section">
      <div className="panel">
        <h2>Join the waitlist</h2>
        <p className="sub">Be first to use Turf, and tell us which plan fits.</p>
        {tier === "custom" && plan && <p className="notice good" role="status">Your plan: {plan}</p>}
        {state.status === "done" ? (
          <p className="notice good" role="status">{state.message}</p>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <label>
              Email
              <input type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
            </label>
            <label>
              Name <span className="opt">(optional)</span>
              <input autoComplete="name" value={form.name} onChange={set("name")} />
            </label>
            <label>
              Company <span className="opt">(optional)</span>
              <input autoComplete="organization" value={form.company} onChange={set("company")} />
            </label>
            <label>
              Plan you are leaning towards
              <select value={tier} onChange={e => setTier(e.target.value, plan)}>
                <option value="">Not sure yet</option>
                {plan && <option value="custom">The plan I built</option>}
                {tiers.filter(t => t.id !== "trial").map(t => (
                  <option key={t.id} value={t.id}>{t.name} · {t.who}</option>
                ))}
              </select>
            </label>
            <input className="trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set("website")} />
            {state.status === "error" && <p className="notice bad" role="alert">{state.message}</p>}
            <button className="button" type="submit" disabled={state.status === "sending"}>
              {state.status === "sending" ? "Joining…" : "Join the waitlist"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export function ContactForm() {
  const { form, set, state, onSubmit } = useForm({ name: "", email: "", message: "", website: "" }, async f => {
    await sendMessage(f);
    return "Thanks. We will reply by email.";
  });
  return (
    <div className="panel">
      <h2>Send us a message</h2>
      {state.status === "done" ? (
        <p className="notice good" role="status">{state.message}</p>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <label>
            Name
            <input autoComplete="name" value={form.name} onChange={set("name")} />
          </label>
          <label>
            Email
            <input type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
          </label>
          <label>
            Message
            <textarea rows={5} required value={form.message} onChange={set("message")} />
          </label>
          <input className="trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={set("website")} />
          {state.status === "error" && <p className="notice bad" role="alert">{state.message}</p>}
          <button className="button" type="submit" disabled={state.status === "sending"}>
            {state.status === "sending" ? "Sending…" : "Send message"}
          </button>
        </form>
      )}
    </div>
  );
}
