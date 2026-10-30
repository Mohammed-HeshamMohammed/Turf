import { useEffect, useMemo, useRef, useState } from "react";
import { useCrm } from "./context.jsx";
import { engineAvailable, locatable, locateAddresses, zipPlaces } from "./engine.js";

const placeOf = lead => (lead.geo && Number.isFinite(lead.geo.lat) && Number.isFinite(lead.geo.lng) ? lead.geo : null);

/**
 * Places leads on every map the same way. Leads with a ZIP but no place go on the map at once at their ZIP centre (a
 * file shipped with Caller Whale, offline). `locate()` looks up the exact addresses still to find, when the person asks.
 * Places are kept on the leads (the LOCATE action), so each address is found once for every map.
 */
export function useLeadPlaces(leads) {
  const { dispatch, notify } = useCrm();
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

  async function locate() {
    const asked = counts.toLocate;
    if (!asked.length || locating) return;
    setLocating({ done: 0, total: asked.length });
    try {
      const { places, notFound } = await locateAddresses(asked, {
        onStage: event => event.total && setLocating({ done: event.done || 0, total: event.total }),
      });
      dispatch({ type: "LOCATE", places, notFound });
      const found = Object.keys(places).length;
      notify(
        `Located ${found.toLocaleString()} of ${asked.length.toLocaleString()} addresses` +
          (notFound.length ? ` · ${notFound.length.toLocaleString()} not found` : ""),
      );
    } catch (reason) {
      notify("Addresses could not be located: " + reason.message);
    } finally {
      setLocating(null);
    }
  }

  return { engine, locating, locate, ...counts };
}

/** The button both maps show: how many addresses are still to find, and the progress while they are looked up. */
export function locateLabel({ locating, toLocate }) {
  return locating
    ? `Locating… ${locating.done.toLocaleString()} of ${locating.total.toLocaleString()}`
    : `Find exact locations (${toLocate.length.toLocaleString()})`;
}
