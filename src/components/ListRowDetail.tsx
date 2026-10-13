import { useState } from "react";
import type { Turf } from "../App";
import { MANUAL_MARKS, MANUAL_LABELS, formatPhone } from "../lib/marks";
import type { DatasetRow } from "../lib/types";
import type { OwnerColumns, OwnerIndex } from "../lib/owners";
import { photosFor, photosIn, positionOf, type PhotoIndex, type PlaceColumns } from "../lib/photos";
import { Field, VerdictPill } from "./Bits";
import { Icon } from "./Icon";
import { PhoneChoices } from "./PhoneChoices";
import { PhotoGallery } from "./PropertyPhoto";
import { AreaPanel } from "./AreaPanel";
import { FloodLine } from "./FloodLine";
import { OwnerPanel, type MailCheck } from "./OwnerPanel";

const photoCount = (count: number) => (count ? `${count} ${count === 1 ? "photo" : "photos"}, shown above` : "No photo");

export function ListRowDetail({
  row,
  own,
  phoneColumns,
  number,
  manual,
  onMark,
  datasetId,
  onUpdated,
  photos,
  owner,
}: {
  row: DatasetRow;
  own: string[];
  phoneColumns: string[];
  number: string | null;
  manual: Turf["manual"];
  onMark: Turf["setMark"];
  datasetId: string;
  onUpdated: () => Promise<void>;
  photos: { columns: string[]; place: PlaceColumns; index: PhotoIndex; exact?: [number, number] };
  owner: { columns: OwnerColumns; index: OwnerIndex; datasetId: string; mail: MailCheck } | null;
}) {
  const found = photosFor(row, photos.columns, photos.place, photos.index, photos.exact);
  const where = positionOf(row, photos.place, photos.exact);
  const numbers = [
    ...new Set(
      phoneColumns.flatMap(column =>
        String(row.raw[`${column} (E.164)`] ?? "")
          .split(";")
          .map(value => value.trim())
          .filter(value => /^\+\d{6,15}$/.test(value)),
      ),
    ),
  ];
  const [chosen, setChosen] = useState(number ?? numbers[0] ?? "");
  const activeNumber = numbers.includes(chosen) ? chosen : (number ?? numbers[0] ?? "");
  const mark = manual[activeNumber]?.mark ?? null;
  return (
    <div className="row-detail">
      {(found.photos.length > 0 || where) && <PhotoGallery photos={found.photos} position={where} label={`Row ${row.row_number}`} borrowed={found.borrowed} />}
      {owner && <OwnerPanel row={row} owner={owner} />}
      {where && <AreaPanel position={where} />}
      {where && <FloodLine position={where} />}
      <dl>
        {own.map(name => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {photos.columns.includes(name) ? (
                photoCount(photosIn(row.raw[name], name).length)
              ) : /url/i.test(name) && row.raw[name] ? (
                <a href={String(row.raw[name])} target="_blank" rel="noreferrer">
                  {row.raw[name]}
                </a>
              ) : (
                (row.raw[name] ?? "–")
              )}
            </dd>
          </div>
        ))}
      </dl>
      {phoneColumns.length > 0 && (
        <div className="detail-side">
          <PhoneChoices raw={row.raw} datasetId={datasetId} rowNumber={row.row_number} onSaved={onUpdated} />
          <h3>Phone checks</h3>
          <ul className="phone-checks">
            {phoneColumns
              .filter(name => row.raw[`${name} (verdict)`])
              .map(name => (
                <li key={name}>
                  <div>
                    <strong>{name}</strong> {formatPhone(row.raw[`${name} (E.164)`] ? String(row.raw[`${name} (E.164)`]) : null) || row.raw[name]}{" "}
                    <small>{row.raw[`${name} (type)`]}</small>
                  </div>
                  <VerdictPill verdict={row.raw[`${name} (verdict)`] as never} />
                  <p>{row.raw[`${name} (why)`]}</p>
                </li>
              ))}
          </ul>
          <h3>Mark this number</h3>
          {activeNumber ? (
            <>
              {numbers.length > 1 && (
                <Field
                  label="Number to mark"
                  value={activeNumber}
                  onChange={value => setChosen(value ?? "")}
                  options={numbers.map(value => ({ value, label: formatPhone(value) }))}
                />
              )}
              <div className="mark-buttons">
                {MANUAL_MARKS.map(item => (
                  <button
                    key={item}
                    type="button"
                    className="button ghost"
                    aria-pressed={mark === item}
                    onClick={() => onMark(activeNumber, mark === item ? null : item)}
                  >
                    {mark === item && <Icon name="check" size={14} />}
                    {MANUAL_LABELS[item]}
                  </button>
                ))}
              </div>
              {mark === "do_not_call" && (
                <label className="field">
                  <span>Do-not-call end date (optional)</span>
                  <input
                    className="input"
                    type="date"
                    value={manual[activeNumber]?.until ?? ""}
                    onChange={event => onMark(activeNumber, "do_not_call", event.target.value || null)}
                  />
                </label>
              )}
              <p className="muted">
                The mark is kept for {formatPhone(activeNumber)} across this project's lists and used by the next phone check. Called alone does not prove a
                person answered. Previous marks are kept in history.
              </p>
            </>
          ) : (
            <p className="muted">This row has no readable number to mark.</p>
          )}
        </div>
      )}
    </div>
  );
}
