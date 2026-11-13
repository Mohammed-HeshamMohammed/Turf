import { useEffect, useMemo, useRef, useState } from "react";
import { useCrm } from "./context.jsx";
import { engineAvailable, locatable, locateAddresses, zipPlaces } from "./engine.ts";

const AUTO_LIMIT = 2000;
const placeOf = lead => (lead.geo && Number.isFinite(lead.geo.lat) && Number.isFinite(lead.geo.lng) ? lead.geo : null);

/**
 * Places leads on every map the same way. Leads with a ZIP but no place go on the map at once at their ZIP centre (a
 * file shipped with Caller Whale, offline). `locate()` looks up the exact addresses still to find, when the person asks.
 * Places are kept on the leads (the LOCATE action), so each address is found once for every map.
 */
export function useLeadPlaces(leads, { auto = false } = {}) {
  const { dispatch, notify, state } = useCrm();
  const [engine, setEngine] = useState(null);
  const [locating, setLocating] = useState(null);
  const tried = useRef(new Set());

  useEffect(() => {
    let live = true;
    engineAvailable().then(value => live && setEngine(value));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!engine) return;
    const waiting = leads.filter(lead => lead.id && !placeOf(lead) && lead.zip && !tried.current.has(lead.id));
    if (!waiting.length) return;
    waiting.forEach(lead => tried.current.add(lead.id));
    zipPlaces(waiting).then(
      places => Object.keys(places).length && dispatch({ type: "LOCATE", places }),
      () => {},
    );
  }, [engine, leads, dispatch]);

  const counts = useMemo(() => {
    let placed = 0,
      exact = 0,
      notFound = 0;
    const toLocate = [];
    for (const lead of leads) {
      const place = placeOf(lead);
      if (place) placed++;
      if (place?.precision === "address") exact++;
      else if (lead.geo?.notFound) notFound++;
      else if (locatable(lead)) toLocate.push(lead);
    }
    return { placed, exact, notFound, toLocate, unplaced: leads.length - placed };
  }, [leads]);

  async function run(asked, quiet) {
    if (!asked.length || locating) return;
    setLocating({ done: 0, total: asked.length });
    try {
      const { places, notFound } = await locateAddresses(asked, {
        onStage: event => event.total && setLocating({ done: event.done || 0, total: event.total }),
      });
      dispatch({ type: "LOCATE", places, notFound });
      const found = Object.keys(places).length;
      if (!quiet)
        notify(
          `Located ${found.toLocaleString()} of ${asked.length.toLocaleString()} addresses` +
            (notFound.length ? ` · ${notFound.length.toLocaleString()} not found` : ""),
        );
    } catch (reason) {
      if (!quiet) notify("Addresses could not be located: " + reason.message);
    } finally {
      setLocating(null);
    }
  }

  const locate = () => run(counts.toLocate, false);

  // With `auto`, the addresses still to find are looked up as soon as the map shows them, quietly and each lead once (a failed or
  // unfound one is not asked again on its own; the button is still there). At most AUTO_LIMIT per map, so a huge list is left to the button.
  const autoTried = useRef(new Set());
  useEffect(() => {
    if (!auto || !engine || locating || !state.online) return;
    const fresh = counts.toLocate.filter(lead => !autoTried.current.has(lead.id)).slice(0, Math.max(0, AUTO_LIMIT - autoTried.current.size));
    if (!fresh.length) return;
    fresh.forEach(lead => autoTried.current.add(lead.id));
    run(fresh, true);
  });

  return { engine, locating, locate, ...counts };
}

/** The button both maps show: how many addresses are still to find, and the progress while they are looked up. */
export function locateLabel({ locating, toLocate }) {
  return locating
    ? `Locating… ${locating.done.toLocaleString()} of ${locating.total.toLocaleString()}`
    : `Find exact locations (${toLocate.length.toLocaleString()})`;
}
