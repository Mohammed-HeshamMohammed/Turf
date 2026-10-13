import { phoneColumnsOf, progressKind, statusKey } from "./dashboard";
import { areaColumns, ownColumns } from "./marks";
import { placeColumns, streetKey, type PlaceColumns } from "./photos";
import type { AreaMapping, Dataset, DatasetRow, SkiptraceSuggestion } from "./types";

// Who owns a property and how to reach them, from the lists themselves: the kind of owner a name shows, where the
// owner gets mail, and contacts or owner names that another list in the project has for the same owner or property.
// Wording rules come first; a name that fits none of them is a person, or a household when it joins two names.

export type OwnerKind = "person" | "household" | "company" | "trust" | "estate" | "government" | "bank";
export const OWNER_KINDS: { id: OwnerKind; label: string; hint: string }[] = [
  { id: "person", label: "Person", hint: "One person owns it" },
  { id: "household", label: "Household", hint: "Two or more people own it together" },
  { id: "company", label: "Company or LLC", hint: "A business owns it; the people behind it are elsewhere" },
  { id: "trust", label: "Trust", hint: "A trust owns it; the trustee decides" },
  { id: "estate", label: "Estate", hint: "The owner may have died; heirs or an executor decide" },
  { id: "government", label: "Government", hint: "A city, county, state or school district owns it" },
  { id: "bank", label: "Bank or lender", hint: "A bank or lender owns it, often after foreclosure" },
];

const KIND_RULES: [RegExp, OwnerKind][] = [
  [/\b(estate of|est of|heirs? of|heirs|life estate|deceased|dec'?d)\b|\best\.?$/i, "estate"],
  [/\b(trusts?|trustees?|ttees?|trs?|living tr|revocable|irrevocable)\b/i, "trust"],
  [
    /\b(city of|county of|state of|isd|independent school|school district|housing authority|united states|secretary of|department of|dept of|municipal)\b/i,
    "government",
  ],
  [/\b(bank|banc|credit union|mortgage|savings|fannie mae|freddie mac|fnma|fhlmc|loan servicing)\b|\bn\.?a\.?$/i, "bank"],
  [
    /\b(llc|l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|plc|partners|partnership|holdings?|properties|investments?|investors|capital|group|enterprises?|ventures?|realty|development|management|associates|association|church|ministries|foundation|hoa|condominiums?)\b/i,
    "company",
  ],
];
const HOUSEHOLD = /&|\band\b|;|\bet ?(ux|vir|al)\b/i;

/** The kind of owner a name shows. */
export function ownerKind(name: string): OwnerKind | null {
  const text = name.trim();
  if (!/[a-z]/i.test(text)) return null;
  for (const [pattern, kind] of KIND_RULES) if (pattern.test(text)) return kind;
  return HOUSEHOLD.test(text) ? "household" : "person";
}

const NOT_A_NAME = new Set([
  "llc",
  "inc",
  "co",
  "corp",
  "ltd",
  "lp",
  "trust",
  "trustee",
  "tr",
  "estate",
  "of",
  "the",
  "and",
  "et",
  "al",
  "etux",
  "etvir",
  "ux",
  "vir",
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "mr",
  "mrs",
  "ms",
  "dr",
  "family",
  "living",
  "revocable",
  "irrevocable",
  "heirs",
  "est",
]);

/** The words of a name, in any order: "SMITH JOHN & MARY" and "John & Mary Smith" share them. */
export function nameWords(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z']+/)
      .filter(word => word.length >= 2 && !NOT_A_NAME.has(word)),
  );
}

const shared = (a: Set<string>, b: Set<string>) => [...a].filter(word => b.has(word)).length;

// -------------------------------------------------------------------------------------------- columns of a list

export type OwnerColumns = {
  names: string[];
  place: PlaceColumns;
  state?: string;
  mail: { street?: string; city?: string; state?: string; zip?: string };
  phones: string[];
  emails: string[];
  status?: string;
  statusKinds?: Map<string, ReturnType<typeof progressKind>>;
};

/** Where a list keeps owner names, the property, the mailing address and contacts: its Skip Tracing setup first. */
export function ownerColumns(columns: string[], setup?: SkiptraceSuggestion | null, saved?: AreaMapping): OwnerColumns {
  const own = ownColumns(columns);
  const config = setup?.config;
  const find = (pattern: RegExp) => own.find(name => pattern.test(name.trim()));
  const mapped = (value?: string | null) => (value && own.includes(value) ? value : undefined);
  const names = [mapped(config?.name_column), mapped(config?.first_name_column), mapped(config?.last_name_column)].filter((value): value is string =>
    Boolean(value),
  );
  const named = find(/^(owner ?1? ?)?(full )?name$|^owner$|^owner ?1$|owner name/i);
  const first = find(/^(owner ?1? ?)?first ?name$/i),
    last = find(/^(owner ?1? ?)?last ?name$/i);
  return {
    names: names.length ? names : named ? [named] : [first, last].filter((value): value is string => Boolean(value)),
    place: placeColumns(columns, saved),
    state: areaColumns(columns, saved).state,
    mail: {
      street: mapped(config?.mailing_address_column) ?? find(/^(owner ?)?mail(ing)? ?(address|street|addr)( ?1)?$/i),
      city: mapped(config?.mailing_city_column) ?? find(/^(owner ?)?mail(ing)? ?city$/i),
      state: mapped(config?.mailing_state_column) ?? find(/^(owner ?)?mail(ing)? ?state$/i),
      zip: mapped(config?.mailing_zip_column) ?? find(/^(owner ?)?mail(ing)? ?(zip|zip ?code|postal ?code)$/i),
    },
    phones: phoneColumnsOf(columns, setup),
    emails: own.filter(name => /e-?mail/i.test(name)),
    status: setup?.outcome_column ?? undefined,
    statusKinds: setup?.outcome_column ? new Map(setup.statuses.filter(status => status.key).map(status => [status.key, progressKind(status)])) : undefined,
  };
}

const cell = (row: DatasetRow, column?: string) => (column ? String(row.raw[column] ?? "").trim() : "");

/** A phone as ten digits (US numbers), or as its digits when it has another length. */
export function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits : null;
}

const EMAIL = /[^@\s,;<>"']+@[^@\s,;<>"']+\.[a-z]{2,}/gi;

export function contactsOf(row: DatasetRow, columns: OwnerColumns) {
  const phones = new Set<string>();
  for (const column of columns.phones)
    for (const part of cell(row, column).split(/[;,/|]|\s{2,}/)) {
      const key = phoneKey(part);
      if (key) phones.add(key);
    }
  const emails = new Set<string>();
  for (const column of columns.emails) for (const match of cell(row, column).match(EMAIL) ?? []) emails.add(match.toLowerCase());
  return { phones, emails };
}

// ------------------------------------------------------------------------------------------------ one owner's facts

export type OwnerFacts = {
  name: string;
  kind: OwnerKind | null;
  absentee: boolean;
  outOfState: boolean;
  poBox: boolean;
  mailing: string;
};

const PO_BOX = /\bp\.?\s*o\.?\s*box\b|\bpost office box\b|^box\s+\d/i;

export function ownerFacts(row: DatasetRow, columns: OwnerColumns): OwnerFacts {
  const name = columns.names
    .map(column => cell(row, column))
    .filter(Boolean)
    .join(" ");
  const mailStreet = cell(row, columns.mail.street);
  const property = streetKey(cell(row, columns.place.street));
  const mailing = streetKey(mailStreet);
  const mailZip = cell(row, columns.mail.zip).slice(0, 5),
    zip = cell(row, columns.place.zip).slice(0, 5);
  const mailState = cell(row, columns.mail.state).toUpperCase(),
    state = cell(row, columns.state).toUpperCase();
  return {
    name,
    kind: name ? ownerKind(name) : null,
    absentee: Boolean(mailing && property) && (mailing !== property || Boolean(mailZip && zip && mailZip !== zip)),
    outOfState: Boolean(mailState && state && mailState.length === 2 && state.length === 2 && mailState !== state),
    poBox: PO_BOX.test(mailStreet),
    mailing: [mailStreet, cell(row, columns.mail.city), [mailState, mailZip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
  };
}

// ---------------------------------------------------------------------------------- the same owner in other lists

export type FoundContact = { value: string; kind: "phone" | "email"; list: string; basis: string; warning?: string };
type Entry = { list: string; datasetId: string; words: Set<string>; owner: string; phones: Set<string>; emails: Set<string>; warning?: string };
export type OwnerIndex = { byProperty: Map<string, Entry[]>; byMailing: Map<string, Entry[]> };

const propertyKey = (row: DatasetRow, columns: OwnerColumns) => {
  const street = streetKey(cell(row, columns.place.street));
  const zip = cell(row, columns.place.zip).slice(0, 5);
  return street && /\d/.test(street) && zip ? `${street}|${zip}` : null;
};
const mailingKey = (row: DatasetRow, columns: OwnerColumns) => {
  const street = streetKey(cell(row, columns.mail.street));
  const zip = cell(row, columns.mail.zip).slice(0, 5);
  return street && /\d/.test(street) && zip ? `${street}|${zip}` : null;
};

/** Every list's owners and contacts, by property and by mailing address. */
export function ownerIndex(lists: { dataset: Dataset; rows: DatasetRow[]; columns: OwnerColumns }[]): OwnerIndex {
  const index: OwnerIndex = { byProperty: new Map(), byMailing: new Map() };
  const add = (map: Map<string, Entry[]>, key: string | null, entry: Entry) => {
    if (key) map.set(key, [...(map.get(key) ?? []), entry]);
  };
  for (const { dataset, rows, columns } of lists) {
    for (const row of rows) {
      const owner = columns.names
        .map(column => cell(row, column))
        .filter(Boolean)
        .join(" ");
      const { phones, emails } = contactsOf(row, columns);
      const kind = columns.status ? columns.statusKinds?.get(statusKey(row.raw[columns.status])) : undefined;
      const entry: Entry = {
        list: dataset.name,
        datasetId: dataset.id,
        words: nameWords(owner),
        owner,
        phones,
        emails,
        warning: kind === "do_not_call" ? "Do not call there" : kind === "bad_number" ? "Bad number there" : undefined,
      };
      add(index.byProperty, propertyKey(row, columns), entry);
      add(index.byMailing, mailingKey(row, columns), entry);
    }
  }
  return index;
}

/**
 * Contacts for a row from other lists: the same owner at the same property, or the same owner (two name words in
 * common) at the same mailing address. Contacts the row has already are left out. When neither side names an owner,
 * the same property is enough, and the basis says so.
 */
export function foundElsewhere(row: DatasetRow, datasetId: string, columns: OwnerColumns, index: OwnerIndex): FoundContact[] {
  const words = nameWords(columns.names.map(column => cell(row, column)).join(" "));
  const own = contactsOf(row, columns);
  const found = new Map<string, FoundContact>();
  const take = (entries: Entry[] | undefined, basis: (entry: Entry) => string | null) => {
    for (const entry of entries ?? []) {
      if (entry.datasetId === datasetId) continue;
      const why = basis(entry);
      if (!why) continue;
      for (const phone of entry.phones)
        if (!own.phones.has(phone) && !found.has(phone))
          found.set(phone, { value: phone, kind: "phone", list: entry.list, basis: why, warning: entry.warning });
      for (const email of entry.emails)
        if (!own.emails.has(email) && !found.has(email)) found.set(email, { value: email, kind: "email", list: entry.list, basis: why });
    }
  };
  take(index.byProperty.get(propertyKey(row, columns) ?? ""), entry =>
    words.size && entry.words.size
      ? shared(words, entry.words)
        ? "Same owner, same property"
        : null
      : !words.size && !entry.words.size
        ? "Same property; no owner name to compare"
        : null,
  );
  take(index.byMailing.get(mailingKey(row, columns) ?? ""), entry => (shared(words, entry.words) >= 2 ? "Same owner, same mailing address" : null));
  return [...found.values()];
}

/** Another list that names a different owner for the same property: sold since, or the wrong owner in one of them. */
export function otherOwners(row: DatasetRow, datasetId: string, columns: OwnerColumns, index: OwnerIndex): { list: string; owner: string }[] {
  const words = nameWords(columns.names.map(column => cell(row, column)).join(" "));
  if (!words.size) return [];
  const seen = new Set<string>();
  return (index.byProperty.get(propertyKey(row, columns) ?? "") ?? [])
    .filter(
      entry =>
        entry.datasetId !== datasetId &&
        entry.words.size &&
        !shared(words, entry.words) &&
        !seen.has(entry.list + entry.owner) &&
        seen.add(entry.list + entry.owner),
    )
    .map(entry => ({ list: entry.list, owner: entry.owner }));
}
