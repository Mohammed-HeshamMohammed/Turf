import { useEffect, useState } from "react";
import { censusArea, setCensusKey, type CensusArea } from "../lib/service";
import { formatNumber } from "../lib/marks";

const money = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `$${formatNumber(Math.round(value))}`);
const share = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`);

/** The Census tract around a property, and its figures once the person has added their free Census key. */
export function AreaPanel({ position }: { position: [number, number] }) {
  const [answer, setAnswer] = useState<CensusArea | null>(null);
  const [asked, setAsked] = useState(0);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let timer = 0;
    let tries = 0;
    const ask = () =>
      censusArea(position[0], position[1]).then(
        result => {
          if (!current) return;
          setAnswer(result);
          if (result.pending && tries++ < 30) timer = window.setTimeout(ask, 2500);
        },
        () => current && setAnswer({ unavailable: "The Census could not be reached" }),
      );
    void ask();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // The place is its two numbers, not the array that holds them, which is made anew on every draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position[0], position[1], asked]);

  async function save() {
    try {
      await setCensusKey(key.trim());
      setKey("");
      setMessage(null);
      setAsked(count => count + 1);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (!answer || (answer.unavailable && !answer.tract))
    return answer?.unavailable ? (
      <section className="area-panel">
        <h4>Area</h4>
        <p className="muted">{answer.unavailable}</p>
      </section>
    ) : null;
  return (
    <section className="area-panel" aria-label="Area">
      <h4>Area {answer.tract && <small className="muted">{answer.tract.name}, US Census</small>}</h4>
      {answer.pending && <p className="muted">Looking up the area…</p>}
      {answer.figures && (
        <dl className="area-figures">
          <div>
            <dt>Median household income</dt>
            <dd>{money(answer.figures.median_income)}</dd>
          </div>
          <div>
            <dt>Owner-occupied homes</dt>
            <dd>{share(answer.figures.owner_occupied_share)}</dd>
          </div>
          <div>
            <dt>Median home value</dt>
            <dd>{money(answer.figures.median_value)}</dd>
          </div>
          <div>
            <dt>Vacant homes</dt>
            <dd>{share(answer.figures.vacant_share)}</dd>
          </div>
        </dl>
      )}
      {answer.figures && (
        <p className="muted area-source">
          American Community Survey {answer.figures.year - 4}–{answer.figures.year}, 5-year estimates for the tract.
        </p>
      )}
      {answer.needs_key && (
        <div className="area-key">
          <p className="muted">
            The tract's income, homeownership and home values need a free Census key: ask for one at api.census.gov/data/key_signup.html, then paste it here. It
            stays on this computer.
          </p>
          <span className="registry-path">
            <input
              className="input"
              value={key}
              placeholder="Census key (40 letters and digits)"
              aria-label="Census key"
              onChange={event => setKey(event.target.value)}
            />
            <button type="button" className="button small" disabled={!key.trim()} onClick={() => void save()}>
              Save
            </button>
          </span>
          {message && <small className="registry-progress">{message}</small>}
        </div>
      )}
    </section>
  );
}
