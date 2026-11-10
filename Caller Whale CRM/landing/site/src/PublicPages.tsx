import { useState, type FormEvent } from "react";
import { PageHead } from "./ui.tsx";
import { Link } from "./nav.tsx";
import { HumanCheck, humanToken } from "./auth/human-check.jsx";
import type { Auth } from "./auth/auth-client.js";
import { parseLegal, versionOf, type Inline } from "./legal.ts";
import termsText from "./legal/terms.md?raw";
import privacyText from "./legal/privacy.md?raw";
import dpaText from "./legal/dpa.md?raw";
import acceptableUseText from "./legal/acceptable-use.md?raw";

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

function InlineText({ parts }: { parts: Inline[] }) {
  return <>{parts.map((part, index) => {
    if (part.kind === "bold") return <strong key={index}>{part.text}</strong>;
    if (part.kind === "placeholder") return <mark key={index} className="legal-fill" title="To be filled in by the company before this is relied on">[{part.text}]</mark>;
    if (part.kind === "link") return part.href?.startsWith("/") ? <Link key={index} to={part.href}>{part.text}</Link> : <a key={index} href={part.href} rel="noopener noreferrer" target="_blank">{part.text}</a>;
    return <span key={index}>{part.text}</span>;
  })}</>;
}

/** A legal text written in Markdown (src/legal/*.md), drawn as a page. */
function LegalPage({ source, eyebrow, lead }: { source: string; eyebrow: string; lead: string }) {
  const blocks = parseLegal(source);
  const title = blocks.find(block => block.kind === "h1");
  const version = versionOf(source);
  return <>
    <PageHead eyebrow={eyebrow} title={title && "inline" in title ? title.inline.map(part => part.text).join("") : eyebrow} lead={lead} />
    <section className="section legal card">
      {blocks.filter(block => block.kind !== "h1").map((block, index) => {
        if (block.kind === "h2") return <h2 key={index}><InlineText parts={block.inline} /></h2>;
        if (block.kind === "h3") return <h3 key={index}><InlineText parts={block.inline} /></h3>;
        if (block.kind === "p") return <p key={index}><InlineText parts={block.inline} /></p>;
        if (block.kind === "ul") return <ul key={index}>{block.items.map((item, i) => <li key={i}><InlineText parts={item} /></li>)}</ul>;
        if (block.kind === "ol") return <ol key={index}>{block.items.map((item, i) => <li key={i}><InlineText parts={item} /></li>)}</ol>;
        if (block.kind === "table") return <div className="legal-table" key={index}><table><thead><tr>{block.head.map((cell, i) => <th key={i}><InlineText parts={cell} /></th>)}</tr></thead><tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}><InlineText parts={cell} /></td>)}</tr>)}</tbody></table></div>;
        return null;
      })}
      <p className="fine">Version {version}. Questions? <Link to="/contact">Contact the team</Link>.</p>
    </section>
  </>;
}

export const Privacy = () => <LegalPage source={privacyText} eyebrow="Privacy" lead="What Caller Whale handles about you, why, and your choices." />;
export const Terms = () => <LegalPage source={termsText} eyebrow="Terms" lead="The agreement for using Caller Whale." />;
export const DataProcessing = () => <LegalPage source={dpaText} eyebrow="Customers" lead="How Caller Whale handles the lists and records you add." />;
export const AcceptableUse = () => <LegalPage source={acceptableUseText} eyebrow="Policy" lead="What we expect when you call, text and email with Caller Whale." />;
