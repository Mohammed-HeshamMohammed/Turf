import { useEmailVerdicts } from "../lib/hooks";
import { contactsOf, foundElsewhere, otherOwners, ownerFacts, OWNER_KINDS, type OwnerColumns, type OwnerIndex } from "../lib/owners";
import { formatPhone } from "../lib/marks";
import type { DatasetRow } from "../lib/types";
import { EmailWithVerdict } from "./EmailWithVerdict";

/** The owner as the lists show them: the kind of owner, where their mail goes, and what other lists have for them. */
export type MailCheck = { found: boolean; missing: boolean; waiting: number; progress: string | null; lookUp: () => void } | null;

export function OwnerPanel({ row, owner }: { row: DatasetRow; owner: { columns: OwnerColumns; index: OwnerIndex; datasetId: string; mail: MailCheck } }) {
  const facts = ownerFacts(row, owner.columns);
  const found = foundElsewhere(row, owner.datasetId, owner.columns, owner.index);
  const others = otherOwners(row, owner.datasetId, owner.columns, owner.index);
  const kind = OWNER_KINDS.find(item => item.id === facts.kind);
  const ownEmails = [...contactsOf(row, owner.columns).emails];
  const verdicts = useEmailVerdicts([...ownEmails, ...found.filter(item => item.kind === "email").map(item => item.value)]);
  if (!facts.name && !facts.mailing && !found.length && !ownEmails.length) return null;
  const flags = [facts.absentee && "Absentee owner", facts.outOfState && "Out of state", facts.poBox && "PO box"].filter(Boolean) as string[];
  return (
    <section className="owner-panel" aria-label="Owner">
      <div className="owner-head">
        <div><h3>{facts.name || "Owner not named"}</h3>{kind && <p className="muted">{kind.hint}</p>}</div>
        {kind && <span className={`pill owner-${kind.id}`}>{kind.label}</span>}
      </div>
      {facts.mailing && <p className="owner-mail"><span className="muted">Mail goes to</span> {facts.mailing}{flags.map(flag => <span key={flag} className="pill pill-suspicious">{flag}</span>)}
        {owner.mail && !facts.poBox && (owner.mail.found ? <span className="pill pill-corroborated" title="The free US Census geocoder matched this address">Address found</span>
          : owner.mail.missing ? <span className="pill pill-suspicious" title="The US Census geocoder could not match this address; check it before mailing">Census can't find it</span>
          : owner.mail.waiting > 0 ? <button type="button" className="link" disabled={Boolean(owner.mail.progress && /looked up|Starting/.test(owner.mail.progress))} onClick={owner.mail.lookUp}>Check this list's {owner.mail.waiting.toLocaleString()} mailing addresses</button> : null)}
        {owner.mail?.progress && <small className="muted">{owner.mail.progress}</small>}</p>}
      {ownEmails.length > 0 && <p className="owner-mail"><span className="muted">Email</span> {ownEmails.map(email => <EmailWithVerdict key={email} email={email} verdict={verdicts.get(email)} />)}</p>}
      {others.map(item => <p key={item.list + item.owner} className="notice">{item.list} names {item.owner} as the owner of this property: it may have been sold, or one list has the wrong owner.</p>)}
      {found.length > 0 && (
        <div className="found-contacts">
          <h4>Found in your other lists</h4>
          <ul>{found.map(item => (
            <li key={item.value}>
              {item.kind === "email" ? <EmailWithVerdict email={item.value} verdict={verdicts.get(item.value)} /> : <strong>{item.value.length === 10 ? formatPhone(`+1${item.value}`) : item.value}</strong>}
              {item.warning && <span className="pill pill-wrong">{item.warning}</span>}
              <small>{item.list} · {item.basis}</small>
            </li>
          ))}</ul>
        </div>
      )}
    </section>
  );
}
