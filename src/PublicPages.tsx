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

function Draft({ title, children }: { title: string; children: React.ReactNode }) {
  return <><PageHead eyebrow="Draft · review before launch" title={title} lead="This page is a working draft and is not yet an approved policy." /><section className="section legal card">{children}<p>Questions about this draft? <Link to="/contact">Contact the team</Link>.</p></section></>;
}

export function Privacy() {
  return <Draft title="Privacy notice">
    <h2>Information we handle</h2><p>When you contact us, you provide a name, email address and message. The contact form sends that information to our team inbox so we can respond. Account sign-in uses a third-party identity provider. Product use may involve lead, call and team records that you add to the workspace.</p>
    <h2>How we use it</h2><p>We use contact details to answer requests and account details to operate access to the service. Workspace records support the features you choose to use. We do not need payment card numbers on this site.</p>
    <h2>Service providers and requests</h2><p>Identity, email and hosting providers may process information needed to run the service. To ask about your information or request its removal, use the <Link to="/contact">contact form</Link>. This draft needs an owner, provider list, retention periods, legal basis, region and rights review before publication.</p>
  </Draft>;
}

export function Terms() {
  return <Draft title="Terms of service">
    <h2>Using Caller Whale</h2><p>Use the service only for lawful work and only with information you are allowed to process. Keep account access secure and give teammates access appropriate to their work. Calling, texting and outreach must follow applicable rules and consent requirements.</p>
    <h2>Plans and availability</h2><p>Features marked preview or coming at launch are not yet generally available. Pricing shown on the site is a launch draft; checkout is not open. A final agreement must describe billing, cancellation, data handling, support and service availability before paid plans begin.</p>
    <h2>Review required</h2><p>This draft does not yet establish a contract. It needs company identity, governing law, liability, dispute, payment and termination terms reviewed before publication.</p>
  </Draft>;
}
