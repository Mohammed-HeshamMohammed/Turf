import type { EmailVerdict } from "../lib/service";

const EMAIL_PILLS: Record<EmailVerdict["verdict"], { label: string; tone: string }> = {
  ok: { label: "Takes mail", tone: "pill-corroborated" },
  role: { label: "Shared box", tone: "pill-suspicious" },
  invalid: { label: "Not an email", tone: "pill-wrong" },
  typo: { label: "Likely typo", tone: "pill-suspicious" },
  disposable: { label: "Throwaway", tone: "pill-wrong" },
  no_mail: { label: "Takes no mail", tone: "pill-wrong" },
  pending: { label: "Checking…", tone: "pill-none" },
  unknown: { label: "Not checked", tone: "pill-none" },
};

/** An email with what its check found; a likely typo shows the address it probably is. */
export function EmailWithVerdict({ email, verdict }: { email: string; verdict?: EmailVerdict }) {
  const pill = verdict ? EMAIL_PILLS[verdict.verdict] : null;
  return (
    <span className="email-verdict" title={verdict?.why}>
      <strong>{email}</strong>
      {pill && <span className={`pill ${pill.tone}`}>{pill.label}</span>}
      {verdict?.suggestion && <small>Probably {verdict.suggestion}</small>}
    </span>
  );
}
