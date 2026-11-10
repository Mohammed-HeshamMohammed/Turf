import { useState, type FormEvent } from "react";
import { PageHead } from "./ui.tsx";
import { Link } from "./nav.tsx";
import { HumanCheck, humanToken } from "./auth/human-check.jsx";
import type { Auth } from "./auth/auth-client.js";

const contactBase = import.meta.env.VITE_CALLERWHALE_GATEWAY_URL || "https://gate.callerwhale.com";

export function Contact({ getAuth }: { getAuth: () => Promise<Auth> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch(`${contactBase}/api/v1/public/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), email: data.get("email"), message, website: data.get("website"), human_token: await humanToken(getAuth, "contact") }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "We could not send your message. Please try again.");
      }
      setSent(true);
      setMessage("");
      form.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not send your message. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return <>
    <PageHead eyebrow="Contact" title="Talk to the Caller Whale team." lead="Questions, feedback or a security report? Send us a message and include an email address where we can reply." />
    <section className="section"><form className="card contact-form" onSubmit={submit}>
      <label>Your name <input name="name" maxLength={120} autoComplete="name" /></label>
      <label>Email <input name="email" type="email" required autoComplete="email" /></label>
      <label>Message <textarea name="message" required maxLength={4000} rows={8} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <div className="contact-trap" aria-hidden="true"><label>Website <input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <HumanCheck getAuth={getAuth} />
      {error && <p className="notice bad" role="alert">{error}</p>}
      {sent && <p className="notice" role="status">Your message was sent. Thank you.</p>}
      <button className="button primary" disabled={busy}>{busy ? "Sending…" : "Send message"}</button>
    </form></section>
  </>;
}

/** A person asks to be removed. Plain words: what this does, what it cannot do, and one box. */
export function RemoveMyInformation({ getAuth }: { getAuth: () => Promise<Auth> }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const phone = String(data.get("phone") || "").trim();
    const email = String(data.get("email") || "").trim();
    if (!phone && !email) {
      setError("Enter the phone number or the email address you want removed.");
      setBusy(false);
      return;
    }
    try {
      const response = await fetch(`${contactBase}/api/v1/public/remove-my-information`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, email, human_token: await humanToken(getAuth, "removal") }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "We could not take your request. Please try again.");
      }
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not take your request. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return <>
    <PageHead eyebrow="Your privacy" title="Remove my information." lead="Ask Caller Whale to remove a phone number or an email address from what it has learned, and not to take it in again." />
    <section className="section"><form className="card contact-form" onSubmit={submit}>
      <p>Businesses that use Caller Whale add lists of people to their own workspaces. Caller Whale keeps a scrambled copy of some details, only to improve its service. Give a phone number or an email address and we will delete that copy in every workspace and make sure it is not taken in again.</p>
      <label>Phone number <input name="phone" type="tel" autoComplete="tel" maxLength={40} /></label>
      <label>Email address <input name="email" type="email" autoComplete="email" maxLength={254} /></label>
      <HumanCheck getAuth={getAuth} />
      {error && <p className="notice bad" role="alert">{error}</p>}
      {done && <p className="notice" role="status">Done. We removed what Caller Whale had learned for that number or address, and it will not be taken in again. We did not keep what you typed.</p>}
      <button className="button primary" disabled={busy || done}>{busy ? "Sending…" : "Remove my information"}</button>
      <p className="fine">This does not remove you from a business's own list. To be taken off a company's list or to stop its calls and texts, contact that company, or add your number to the National Do Not Call Registry at donotcall.gov. Questions? <Link to="/contact">Contact the team</Link>.</p>
    </form></section>
  </>;
}

function Draft({ title, children }: { title: string; children: React.ReactNode }) {
  return <><PageHead eyebrow="Draft · review before launch" title={title} lead="This page is a working draft and is not yet an approved policy." /><section className="section legal card">{children}<p>Questions about this draft? <Link to="/contact">Contact the team</Link>.</p></section></>;
}

export function Privacy() {
  return <Draft title="Privacy notice">
    <h2>Information we handle</h2><p>When you contact us, you provide a name, email address and message. The contact form sends that information to our team inbox so we can respond. Account sign-in uses a third-party identity provider. Product use may involve lead, call and team records that you add to the workspace.</p>
    <h2>How we use it</h2><p>We use contact details to answer requests and account details to operate access to the service. Workspace records support the features you choose to use. We do not need payment card numbers on this site.</p>
    <h2>Lists added by businesses</h2><p>Businesses that use Caller Whale add lists of people to their workspaces. After a list is added, Caller Whale keeps a scrambled copy of some details, only to improve its service: phone numbers and emails as one-way codes, the kind of name (person or company), city, state and ZIP, a few property facts, and what the business decides about each lead. It does not keep names, phone numbers, emails, street addresses, notes or recordings, does not sell or share this copy, and deletes it after two years. A person can have it removed at any time with <Link to="/remove-my-information">Remove my information</Link>. This section is a draft that needs legal review.</p>
    <h2>Service providers and requests</h2><p>Identity, email and hosting providers may process information needed to run the service. To ask about your information, use the <Link to="/contact">contact form</Link>. To have a phone number or an email address removed from what Caller Whale has learned from business lists, use <Link to="/remove-my-information">Remove my information</Link>. This draft needs an owner, provider list, retention periods, legal basis, region and rights review before publication.</p>
  </Draft>;
}

export function Terms() {
  return <Draft title="Terms of service">
    <h2>Using Caller Whale</h2><p>Use the service only for lawful work and only with information you are allowed to process. Keep account access secure and give teammates access appropriate to their work. Calling, texting and outreach must follow applicable rules and consent requirements.</p>
    <h2>Plans and availability</h2><p>Features marked preview or coming at launch are not yet generally available. Pricing shown on the site is a launch draft; checkout is not open. A final agreement must describe billing, cancellation, data handling, support and service availability before paid plans begin.</p>
    <h2>Review required</h2><p>This draft does not yet establish a contract. It needs company identity, governing law, liability, dispute, payment and termination terms reviewed before publication.</p>
  </Draft>;
}
