import { formatNumber } from "../lib/marks";
import type { DuplicateSummary } from "../lib/types";

const rowsOf = (count: number) => `${formatNumber(count)} ${count === 1 ? "row" : "rows"}`;

/**
 * What the check found about rows that repeat a lead: the rows that are the same lead (and which one to keep), the
 * ones that might be, and the owners who are in the list with several properties. Nothing is removed from the list;
 * the checked copy says, row by row, what each one is.
 */
export function SkiptraceDuplicates({ found, showRows }: { found: DuplicateSummary | null | undefined; showRows: (filter: string) => void }) {
  // A check from before Turf looked for repeated leads says nothing about them.
  if (found === undefined) return null;
  if (found === null)
    return (
      <article className="card step">
        <header>
          <h2>Repeated leads</h2>
        </header>
        <p className="muted">Looking for rows that repeat the same lead is turned off for this list. Turn it on under More settings in Warning signs.</p>
      </article>
    );
  const nothing = !found.groups && !found.possible_rows && !found.owner_groups;
  return (
    <article className="card step duplicates">
      <header>
        <h2>Repeated leads</h2>
        <span className="count">{formatNumber(found.compared_pairs)} pairs of rows compared</span>
      </header>
      {nothing ? (
        <p className="results-headline">
          <strong>No row repeats another.</strong> Rows that share a phone, an email, an address or a name were compared with each other.
        </p>
      ) : (
        <>
          <p className="results-headline">
            {found.groups ? (
              <>
                <strong>{rowsOf(found.duplicate_rows)}</strong> {found.duplicate_rows === 1 ? "repeats" : "repeat"} a lead that is already in this list. Calling
                each lead once leaves {formatNumber(found.duplicate_rows)} fewer to call.
              </>
            ) : (
              <>
                <strong>No row surely repeats another</strong>, but some are worth a look.
              </>
            )}
          </p>
          <div className="action-summary">
            <button type="button" className="summary-item" disabled={!found.groups} onClick={() => showRows("duplicates")}>
              <strong>{formatNumber(found.groups)}</strong>
              <span>{found.groups === 1 ? "Lead written more than once" : "Leads written more than once"}</span>
              <small>{found.groups ? `${rowsOf(found.rows_in_groups)} in all: one kept, the rest marked · Review →` : "Each lead is in the list once"}</small>
            </button>
            <button type="button" className="summary-item" disabled={!found.possible_rows} onClick={() => showRows("possible_duplicates")}>
              <strong>{formatNumber(found.possible_rows)}</strong>
              <span>{found.possible_rows === 1 ? "Row that might repeat another" : "Rows that might repeat another"}</span>
              <small>{found.possible_rows ? "Something agrees, but not enough to be sure · Review →" : "Nothing left in doubt"}</small>
            </button>
            <button type="button" className="summary-item" disabled={!found.owner_groups} onClick={() => showRows("same_owner")}>
              <strong>{formatNumber(found.owner_groups)}</strong>
              <span>{found.owner_groups === 1 ? "Owner with several properties" : "Owners with several properties"}</span>
              <small>{found.owner_groups ? `${rowsOf(found.owner_rows)}: one person to call about each · Review →` : "No owner is in the list twice"}</small>
            </button>
          </div>
          {found.examples.length > 0 && (
            <details className="step skiptrace-optional" open={found.groups <= 3}>
              <summary>
                {found.groups > found.examples.length
                  ? `The first ${found.examples.length} of ${formatNumber(found.groups)} repeated leads`
                  : "The repeated leads"}
              </summary>
              <ul className="duplicate-groups">
                {found.examples.map(group => (
                  <li key={group.group}>
                    <p>
                      <strong>{group.group}</strong> <span className="muted">{group.why}</span>
                    </p>
                    <ul>
                      {group.rows.map(row => (
                        <li key={row.row_number}>
                          <span className="num muted">Row {row.row_number}</span>
                          <span>{row.label || "No name, address or phone"}</span>
                          {row.keep ? <span className="pill pill-corroborated">Keep</span> : <span className="pill pill-none">Duplicate</span>}
                        </li>
                      ))}
                      {group.size > group.rows.length && <li className="muted">and {group.size - group.rows.length} more</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {found.owner_examples.length > 0 && (
            <details className="step skiptrace-optional">
              <summary>Owners with several properties</summary>
              <ul className="duplicate-groups">
                {found.owner_examples.map(group => (
                  <li key={group.rows[0].row_number}>
                    <ul>
                      {group.rows.map(row => (
                        <li key={row.row_number}>
                          <span className="num muted">Row {row.row_number}</span>
                          <span>{row.label}</span>
                        </li>
                      ))}
                      {group.size > group.rows.length && <li className="muted">and {group.size - group.rows.length} more</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <p className="muted">
        No row is removed. The checked copy says which row to keep and which repeat it, and why, in its Duplicate columns; in Lists you can show only the
        repeats.
        {!found.has_names && " Map the owner's name in Column roles for surer answers: without a name, the same phone alone is only a possible repeat."}
        {found.ignored_shared_values > 0 &&
          ` ${formatNumber(found.ignored_shared_values)} ${found.ignored_shared_values === 1 ? "number or email is" : "numbers or emails are"} on many rows under different names (an office line, a placeholder) and did not count.`}
        {found.skipped_groups > 0 &&
          ` ${formatNumber(found.skipped_groups)} very large ${found.skipped_groups === 1 ? "group" : "groups"} of rows sharing one value (a common name in one ZIP, say) ${found.skipped_groups === 1 ? "was" : "were"} not compared inside, to keep the check quick.`}
      </p>
    </article>
  );
}
