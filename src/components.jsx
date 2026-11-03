import { useEffect, useRef, useState } from "react";
import {
  ArrowRight, ArrowUpRight, Archive, Buildings, Circle, CreditCard, DeviceMobile, Export, HardDrives, IdentificationBadge, Kanban,
  ListChecks, LockKey, MagnifyingGlass, MapTrifold, Phone, ShieldCheck, Sparkle, UploadSimple, Users, WifiSlash,
} from "@phosphor-icons/react";
import { STATUS, faqs, footerLinks, tiers } from "./content.js";
import { joinWaitlist, sendMessage } from "./api.js";
import { loadAuth } from "./session.jsx";
import { HumanCheck } from "./auth/human-check.jsx";
import { useSession } from "./session.jsx";
import { MotionToggle } from "./motion.jsx";

/** Google's own mark in its own colours, where the site talks about signing in with Google. */
const GoogleLogo = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z" />
  </svg>
);

const ICONS = {
  ArrowRight, ArrowUpRight, Archive, Buildings, CreditCard, DeviceMobile, Export, GoogleLogo, HardDrives, IdentificationBadge, Kanban,
  ListChecks, LockKey, MagnifyingGlass, MapTrifold, Phone, ShieldCheck, Sparkle, UploadSimple, Users, WifiSlash,
};

export const Icon = ({ name, size = 22 }) => {
  const Component = ICONS[name] || Circle;
  return <Component size={size} weight="duotone" aria-hidden="true" />;
};

/** Supplied temporary orca artwork, displayed through a tight viewBox without redrawing it. */
export const Logo = ({ size = 32 }) => (
  <svg className="logo orca-mark" width={size} height={size} viewBox="195 60 230 245" aria-hidden="true" focusable="false">
    <image href="/brand/callerwhale-orca.png" width="629" height="360" />
  </svg>
);

/** Fades a block in once as it scrolls into view. Without motion preference, or without IntersectionObserver, it just shows. */
export function Reveal({ children, as: Tag = "div", className = "", ...rest }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  const [ready, setReady] = useState(false);
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
    setReady(true);
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} className={`reveal ${ready ? "motion-ready" : ""} ${shown ? "in" : ""} ${className}`} {...rest}>
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
      <img src={`/screens/${file}.webp`} width="1440" height="900" alt={alt} decoding="async" loading={eager ? "eager" : "lazy"} fetchPriority={eager ? "high" : undefined} />
    </figure>
  );
}

/**
 * The site's header. Signed out: Sign in and Request access. Signed in: Dashboard for authorized accounts,
 * and Sign out. What a person may open is the server's decision (/account); the header only shows it.
 */
export function Header({ route }) {
  const [open, setOpen] = useState(false);
  const session = useSession();
  const menuButton = useRef(null);
  const menu = useRef(null);
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    const outside = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !menuButton.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 961px)");
    const dismissOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", dismissOnDesktop);
    return () => desktop.removeEventListener("change", dismissOnDesktop);
  }, []);
  const links = [
    ["/features", "Product"],
    ["/#workflow", "Workflow"],
    ["/pricing", "Pricing"],
  ];
  const account = session.status === "signed_in" ? session.account : null;
  const invited = Boolean(account?.access);
  return (
    <header className="top">
      <a className="brand" href="/" aria-label="Caller Whale home">
        <Logo />
        Caller Whale
      </a>
      <button
        ref={menuButton}
        type="button"
        className="menu-toggle"
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav
        ref={menu}
        onClick={(event) => {
          if (event.target.closest("a")) setOpen(false);
        }}
        id="site-nav"
        aria-label="Site"
        className={open ? "open" : ""}
      >
        {links.map(([href, label]) => (
          <a
            key={href}
            href={href}
            aria-current={route === href.slice(1) ? "page" : undefined}
          >
            {label}
          </a>
        ))}
        {session.status === "signed_in" || session.status === "error" ? (
          <>
            {(invited || account?.staff) && (
              <a
                href="/dashboard"
                aria-current={route === "dashboard" ? "page" : undefined}
              >
                Dashboard
              </a>
            )}
            <button
              type="button"
              className="button small ghost"
              onClick={session.signOut}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <a
              href="/signin"
              aria-current={route === "signin" ? "page" : undefined}
            >
              Sign in
            </a>
            <a className="button small" href="/#request-access">
              Request access
            </a>
          </>
        )}
      </nav>
    </header>
  );
}

/** Persistent marketing entry point; entitlement is still enforced by the server. */
export function GetStarted({ route }) {
  const dialog = useRef(null);
  const trigger = useRef(null);
  const session = useSession();
  const signedIn = session.status === "signed_in";
  useEffect(() => { dialog.current?.close(); }, [route]);
  const previousOverflow = useRef(null);
  const restoreScroll = () => {
    if (previousOverflow.current !== null) {
      document.body.style.overflow = previousOverflow.current;
      previousOverflow.current = null;
    }
  };
  useEffect(() => () => restoreScroll(), []);
  const open = () => {
    previousOverflow.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current.showModal();
  };
  const close = () => dialog.current.close();
  const containTab = event => {
    if (event.key !== "Tab") return;
    const items = dialog.current.querySelectorAll('button:not([disabled]), a[href]');
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const downloadPath = signedIn ? "/dashboard#desktop-download" : "/signin?next=%2Fdashboard";
  return <>
    <button ref={trigger} type="button" className="get-started-float" onClick={open} aria-haspopup="dialog" aria-controls="get-started-dialog">Get started <Icon name="ArrowUpRight" size={20} /></button>
    <dialog ref={dialog} id="get-started-dialog" className="entry-dialog" onKeyDown={containTab} onClose={() => { restoreScroll(); trigger.current?.focus(); }} aria-labelledby="entry-title" aria-describedby="entry-description" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="entry-content">
        <button type="button" className="entry-close" onClick={close} aria-label="Close get started">Close</button>
        <p className="studio-label">Your Caller Whale workspace</p>
        <h2 id="entry-title">Your next step<br />starts here.</h2>
        <p id="entry-description">Open your web dashboard or get the desktop app. Caller Whale is currently by invitation.</p>
        <div className="entry-options">
          <a className="entry-option" href={signedIn ? "/dashboard" : "/signin?next=%2Fdashboard"} onClick={close}><Icon name="Kanban" size={24} /><span><strong>{signedIn ? "Open web dashboard" : "Sign in"}</strong><span>{signedIn ? "Continue to your account and workspace." : "Already have an account? Continue to your dashboard."}</span></span><Icon name="ArrowRight" size={20} /></a>
          {!signedIn && <a className="entry-option" href="/signup" onClick={close}><Icon name="Users" size={24} /><span><strong>Sign up</strong><span>Create your account with the email you were invited with.</span></span><Icon name="ArrowRight" size={20} /></a>}
          <a className="entry-option" href={downloadPath} onClick={close}><Icon name="DeviceMobile" size={24} /><span><strong>Get the desktop app</strong><span>{signedIn ? "Find the Windows download in your dashboard." : "Sign in first. Invited accounts can download from their dashboard."}</span></span><Icon name="ArrowRight" size={20} /></a>
        </div>
        <p className="entry-waitlist">No invitation yet? <a href="/#request-access" onClick={close}>Join the waitlist</a>.</p>
      </div>
    </dialog>
  </>;
}

export function Footer() {
  // Signed in, the footer's "Sign in" becomes the way back to the person's own page.
  const signedIn = useSession().status === "signed_in";
  const columns = footerLinks.map((col) => ({
    ...col,
    links: col.links.map((link) =>
      signedIn && link[1] === "/signin"
        ? ["Your dashboard", "/dashboard"]
        : link,
    ),
  }));
  return (
    <footer className="foot site-footer">
      <div className="footer-masthead"><span>Keep good work moving.</span><a href="/contact">Talk to us <Icon name="ArrowUpRight" size={24} /></a></div>
      <div className="foot-main">
        <div className="foot-brand">
          <a className="brand" href="/">
            <Logo />
            Caller Whale
          </a>
          <p>
            Property outreach, from the first record to the follow-up.
          </p>
        </div>
        {columns.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <h3>{col.title}</h3>
            <ul>
              {col.links.map(([label, href]) => (
                <li key={label}>
                  <a href={href}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="foot-base">
        <span>
          © {new Date().getFullYear()} Caller Whale. All rights reserved.
        </span>
        <div className="footer-controls"><MotionToggle /><ThemeSelect /></div>
      </div>
    </footer>
  );
}

function ThemeSelect() {
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("callerwhale-site-theme");
      if (["system", "light", "dark"].includes(saved)) setTheme(saved);
    } catch {
      /* Theme remains usable when storage is unavailable. */
    }
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <label className="theme-control">
      Appearance
      <select
        value={theme}
        onChange={(event) => {
          setTheme(event.target.value);
          try {
            localStorage.setItem("callerwhale-site-theme", event.target.value);
          } catch {
            /* Storage is optional. */
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
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

export function Faq({ compact = false }) {
  return (
    <section id="faq" className="section band">
      <h2>Questions people ask</h2>
      <div className="faq">
        {(compact ? faqs.filter((_, i) => [0, 1, 2, 8, 9].includes(i)) : faqs).map(f => (
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
      <h2>Ready to work your next list in Caller Whale?</h2>
      <p>Join the waitlist and be first in when the doors open.</p>
      <a className="button light" href="/#waitlist">Join the waitlist</a>
    </Reveal>
  );
}

/** Caller Whale is by invitation: the download is on the invited person's dashboard, not here. */
export function InviteOnly() {
  return (
    <section id="download" className="section band center">
      <h2>Caller Whale is by invitation</h2>
      <p className="sub">Invited? Create your account with the email your invitation went to, and download the desktop app from your dashboard.</p>
      <div className="actions center-actions">
        <a className="button" href="/signup">Accept an invitation</a>
        <a className="button ghost" href="/signin">Sign in</a>
      </div>
    </section>
  );
}

function useForm(initial, submit) {
  const [form, setForm] = useState(initial);
  const [state, setState] = useState({ status: "idle", message: "" });
  const sending = useRef(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  async function onSubmit(e) {
    e.preventDefault();
    if (sending.current || !e.currentTarget.reportValidity()) return;
    sending.current = true;
    setState({ status: "sending", message: "" });
    try {
      setState({ status: "done", message: await submit(form) });
    } catch (err) {
      setState({ status: "error", message: err.message });
    } finally {
      sending.current = false;
    }
  }
  return { form, set, state, onSubmit, setForm };
}

export function Waitlist({ tier, plan, setTier }) {
  const [humanToken, setHumanToken] = useState("");
  const { form, set, state, onSubmit } = useForm(
    { email: "", name: "", company: "", website: "" },
    async (f) => {
      await joinWaitlist({
        ...f,
        tier,
        plan: tier === "custom" ? plan : "",
        human_token: humanToken,
      });
      return "Your interest is recorded. This does not create an account or grant access.";
    },
  );
  return (
    <section id="request-access" className="section access-section">
      <span id="waitlist" className="anchor-alias" aria-hidden="true" />
      <div className="access-copy">
        <p className="studio-label">Early access</p>
        <h2>
          Bring your next list.
          <br />
          We’ll bring the workspace.
        </h2>
        <p>
          Caller Whale is currently by invitation. Leave your details to join the waitlist. Access and desktop downloads require an invitation.
        </p>
        <p>
          Already invited? <a href="/signup">Accept your invitation</a> or{" "}
          <a href="/signin">sign in</a>.
        </p>
      </div>
      <div className="panel">
        <h2>Join the waitlist</h2>
        <p className="sub">
          Leave an email and a little about your work. Joining records your interest; it does not create an account.
        </p>
        {tier === "custom" && plan && (
          <p className="notice good" role="status">
            Your plan: {plan}
          </p>
        )}
        {state.status === "done" ? (
          <p className="notice good" role="status">
            {state.message}
          </p>
        ) : (
          <form onSubmit={onSubmit} noValidate aria-busy={state.status === "sending"}>
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={form.email}
                onChange={set("email")}
              />
            </label>
            <label>
              Name <span className="opt">(optional)</span>
              <input
                autoComplete="name"
                value={form.name}
                onChange={set("name")}
              />
            </label>
            <label>
              Company <span className="opt">(optional)</span>
              <input
                autoComplete="organization"
                value={form.company}
                onChange={set("company")}
              />
            </label>
            <label>
              Plan you are leaning towards
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value, plan)}
              >
                <option value="">Not sure yet</option>
                {plan && <option value="custom">The plan I built</option>}
                {tiers
                  .filter((t) => t.id !== "trial")
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.who}
                    </option>
                  ))}
              </select>
            </label>
            <input
              className="trap"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={form.website}
              onChange={set("website")}
            />
            <HumanCheck getAuth={loadAuth} action="waitlist" onToken={setHumanToken} />
            {state.status === "error" && (
              <p className="notice bad" role="alert">
                {state.message}
              </p>
            )}
            <button
              className="button"
              type="submit"
              disabled={state.status === "sending"} aria-busy={state.status === "sending"}
            >
              {state.status === "sending" ? "Joining…" : "Join the waitlist"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}

export function ContactForm() {
  const [humanToken, setHumanToken] = useState("");
  const { form, set, state, onSubmit } = useForm({ name: "", email: "", message: "", website: "" }, async f => {
    await sendMessage({ ...f, human_token: humanToken });
    return "Thanks. We will reply by email.";
  });
  return (
    <div className="panel">
      <h2>Send us a message</h2>
      {state.status === "done" ? (
        <p className="notice good" role="status">{state.message}</p>
      ) : (
        <form onSubmit={onSubmit} noValidate aria-busy={state.status === "sending"}>
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
          <HumanCheck getAuth={loadAuth} action="contact" onToken={setHumanToken} />
          {state.status === "error" && <p className="notice bad" role="alert">{state.message}</p>}
          <button className="button" type="submit" disabled={state.status === "sending"} aria-busy={state.status === "sending"}>
            {state.status === "sending" ? "Sending…" : "Send message"}
          </button>
        </form>
      )}
    </div>
  );
}
