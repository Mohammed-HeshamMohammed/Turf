import { useState } from "react";
import { ADDONS, BUILDER_FEATURES, MAX_SEATS, clampSeats, preset, quote, summarize } from "./plan.js";

const money = n => `$${n.toLocaleString("en-US")}`;
const LEVELS = [["off", "Off"], ["standard", "Standard"], ["power", "Power"]];
const PRESETS = [["solo", "Solo"], ["duo", "Duo"], ["team", "Team"], ["pro", "Pro"]];

/**
 * "Build your plan": switch features on and off, pick how many people, add extras. The ready-made plans are only
 * starting points; the price is always the sum of what is switched on.
 */
export function PlanBuilder({ onChoose, initial }) {
  const [sel, setSel] = useState(() => initial || preset("solo"));
  const q = quote(sel);
  const canPower = q.seats >= 3;
  const setSeats = n => setSel({ ...sel, seats: clampSeats(n) });
  const setLevel = (id, level) => setSel({ ...sel, levels: { ...sel.levels, [id]: level } });
  const setAddon = (id, n) => setSel({ ...sel, addons: { ...sel.addons, [id]: Math.max(0, Math.min(99, n)) } });
  const limitText = (f, level) => {
    const col = q.seats === 1 ? "solo" : q.seats === 2 ? "duo" : level === "power" ? "pro" : "team";
    return f.limits[col];
  };

  return (
    <div className="builder">
      <div className="builder-main">
        <div className="builder-top">
          <div>
            <h3 id="seats-label">People using Turf</h3>
            <p className="fine">Clients and partners you share with are free.</p>
          </div>
          <div className="stepper" role="group" aria-labelledby="seats-label">
            <button type="button" aria-label="One fewer person" onClick={() => setSeats(q.seats - 1)} disabled={q.seats <= 1}>−</button>
            <output aria-live="polite">{q.seats}</output>
            <button type="button" aria-label="One more person" onClick={() => setSeats(q.seats + 1)} disabled={q.seats >= MAX_SEATS}>+</button>
          </div>
        </div>

        <div className="presets" role="group" aria-label="Start from a ready-made plan">
          <span>Start from</span>
          {PRESETS.map(([id, name]) => (
            <button type="button" key={id} onClick={() => setSel(preset(id))}>{name}</button>
          ))}
        </div>

        <ul className="builder-features">
          {BUILDER_FEATURES.map(f => {
            const line = q.lines.find(l => l.id === f.id);
            return (
              <li key={f.id} className={line.level === "off" ? "off" : ""}>
                <fieldset>
                  <legend>{f.name}</legend>
                  <div className="levels">
                    {LEVELS.map(([level, label]) => {
                      const disabled = level === "power" && !canPower;
                      return (
                        <label key={level} className={disabled ? "disabled" : ""}>
                          <input
                            type="radio"
                            name={`level-${f.id}`}
                            checked={line.level === level}
                            disabled={disabled}
                            onChange={() => setLevel(f.id, level)}
                          />
                          <span>{label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="fine">{line.level === "off" ? "Not in your plan" : limitText(f, line.level)}</p>
                </fieldset>
                <strong className="line-price">{line.level === "off" ? "—" : money(line.price)}</strong>
              </li>
            );
          })}
          <li className="included">
            <div>
              <strong>Always included</strong>
              <p className="fine">Exports, backup and restore, accounts and security</p>
            </div>
            <strong className="line-price">Included</strong>
          </li>
        </ul>
        {!canPower && <p className="fine">Power versions (multi-line dialing and the biggest limits) need three or more people.</p>}

        <h3 className="addons-title">Extras, only when you need them</h3>
        <ul className="addons">
          {ADDONS.map(a => (
            <li key={a.id}>
              <span>
                <strong>{a.name}</strong>
                <span className="fine">{money(a.price)} per {a.unit}</span>
              </span>
              <span className="stepper small" role="group" aria-label={a.name}>
                <button type="button" aria-label={`Fewer ${a.name}`} onClick={() => setAddon(a.id, (sel.addons[a.id] || 0) - 1)} disabled={!sel.addons[a.id]}>−</button>
                <output>{sel.addons[a.id] || 0}</output>
                <button type="button" aria-label={`More ${a.name}`} onClick={() => setAddon(a.id, (sel.addons[a.id] || 0) + 1)}>+</button>
              </span>
            </li>
          ))}
        </ul>
        <p className="fine">
          Need only part of a feature, such as number blocking without the rest of Skip tracing, or texting without
          calling? <a href="/contact">Tell us</a>. We are pricing these as separate pieces.
        </p>
      </div>

      <aside className="builder-sum" aria-label="Your plan">
        <h3>Your plan</h3>
        <p className="total">{money(q.total)}<span> / month</span></p>
        <ul>
          {q.lines.filter(l => l.level !== "off").map(l => (
            <li key={l.id}><span>{l.name}{l.level === "power" ? " (Power)" : ""}</span><span>{money(l.price)}</span></li>
          ))}
          {q.extras.map(e => (
            <li key={e.id}><span>{e.quantity} × {e.name}</span><span>{money(e.total)}</span></li>
          ))}
        </ul>
        {q.saving > 0 && <p className="saving">{money(q.saving)} less than the ready-made plan with every feature.</p>}
        {q.seats >= 3 && <p className="fine">{q.seats} seats × per-seat prices.</p>}
        <p className="fine">Draft prices. Checkout is not open yet.</p>
        <a className="button" href="#waitlist" onClick={() => onChoose("custom", summarize(sel))}>Join the waitlist with this plan</a>
      </aside>
    </div>
  );
}
