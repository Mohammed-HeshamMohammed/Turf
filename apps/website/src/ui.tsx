import type { ReactNode } from "react";
import { STATUS, type Status } from "./content/features.ts";

export function PageHead({ eyebrow, title, lead, children }: { eyebrow?: string; title: string; lead?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      {children}
    </header>
  );
}

/** How far along something is: in the app now, in preview, or coming at launch. */
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge status-${status}`}>{STATUS[status]}</span>;
}

/** An app screenshot from public/screens, with the words a screen reader needs. */
export function Screen({ file, alt }: { file: string; alt: string }) {
  return <img className="screen" src={`/screens/${file}.webp`} alt={alt} loading="lazy" width={1280} height={800} />;
}
