import { Link } from "./nav.tsx";
import type { Status } from "./content/features.ts";
import { PageHead, StatusBadge } from "./ui.tsx";

// What protects accounts and data, written from what the services do. Change the status when the work lands, and change the
// words when the service changes: a security page that is out of date is worse than a short one.
const points: { title: string; text: string; status: Status }[] = [
  {
    title: "Passwords are not kept by us",
    text: "Accounts and passwords are held by Google Firebase, a sign-in provider built for this. Caller Whale's own sign-in service keeps no passwords at all.",
    status: "now",
  },
  {
    title: "Short-lived sessions you can end",
    text: "Each sign-in gets a token that works for 15 minutes and is signed with a private key. It is renewed with a one-time code, and a code used twice ends the session. You can see the devices you are signed in on and sign any of them out.",
    status: "now",
  },
  {
    title: "Guessing is stopped",
    text: "Five failed sign-ins for one email address in 15 minutes pause that account's sign-in. Codes sent by email or text work once, for a short time, with a small number of tries.",
    status: "now",
  },
  {
    title: "Only the front door is public",
    text: "Everything people reach passes through one gateway that limits requests per address and per person, refuses oversized requests, pauses addresses that probe for things that are not there, and hides paths that are meant to be private. Every other service has no public address.",
    status: "now",
  },
  {
    title: "Separate databases, separate keys",
    text: "Each service has its own database and its own login, and services prove who they are to each other with their own keys. What each person may do is decided by one authorization service on every request.",
    status: "now",
  },
  {
    title: "Encrypted in transit",
    text: "This site and our sign-in service are served over HTTPS only, and your browser is told to keep it that way. Service databases accept encrypted connections. Email is sent over an encrypted connection to the mail server.",
    status: "now",
  },
  {
    title: "Bots are told apart from people",
    text: "An invisible check on the sign-in, sign-up and contact forms scores each visit. Nobody ticks a box, and a person acting like a person never sees a challenge. It is built and being switched on.",
    status: "preview",
  },
  {
    title: "Two-step sign-in",
    text: "Sign in with a code from an authenticator app, a recovery code, or a code sent to Telegram. It is built into the sign-in service and required for staff; setting it up from your own account page is coming.",
    status: "preview",
  },
  {
    title: "No card numbers",
    text: "Checkout is handled by the payment provider, and only the provider's signed notice marks a payment paid, so card numbers never reach Caller Whale. Checkout is not open yet.",
    status: "preview",
  },
  {
    title: "Audit log",
    text: "A record of who did what and when, for owners and administrators.",
    status: "soon",
  },
  {
    title: "Single sign-on",
    text: "Sign in through Google Workspace or Microsoft 365 for larger teams.",
    status: "soon",
  },
];

export function Security() {
  return (
    <>
      <PageHead
        eyebrow="Security"
        title="Your records stay yours."
        lead="What protects your account and your data, and which parts are working today and which are still coming. We update this page when the work lands."
      />
      <section className="section">
        <ul className="grid three" style={{ marginTop: 0 }}>
          {points.map(point => (
            <li className="card" key={point.title}>
              <StatusBadge status={point.status} />
              <h3>{point.title}</h3>
              <p>{point.text}</p>
            </li>
          ))}
        </ul>
      </section>
      <section className="section band">
        <h2>Found a problem?</h2>
        <p className="sub">
          If you think you have found a weakness, tell us through the <Link to="/contact">contact form</Link> before telling anyone else. We read
          every report.
        </p>
      </section>
    </>
  );
}
