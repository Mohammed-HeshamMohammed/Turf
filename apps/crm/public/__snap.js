// Style-regression snapshot: for each route, a hash of the computed look of every element, so a stylesheet clean-up
// can be checked to change nothing on screen.
window.__snap = async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (!document.getElementById("snap-noanim")) {
    const st = document.createElement("style");
    st.id = "snap-noanim";
    st.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
    document.head.appendChild(st);
  }
  const props = ["display", "position", "margin", "padding", "font-size", "font-weight", "line-height", "color", "background-color", "background-image", "border-top", "border-bottom", "border-left", "border-right", "border-radius", "grid-template-columns", "gap", "flex-direction", "align-items", "justify-content", "opacity", "box-shadow", "visibility", "overflow-x", "overflow-y", "transform", "letter-spacing", "z-index", "cursor", "white-space", "text-align", "text-decoration-line", "outline-style"];
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
  const routes = ["dashboard", "work/leads", "work/leads/l01", "work/leads/new", "work/calls", "work/deals", "work/deals/deal01", "work/handoffs", "work/tasks", "work/tasks/new", "work/calendar", "work/inbox", "lists", "lists/d01", "team", "reports", "settings", "sync", "personal/profile", "personal/preferences"];
  const out = {};
  for (const r of routes) {
    location.hash = "#/" + r;
    await wait(900);
    const parts = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.closest(".leaflet-container, .recharts-wrapper, script, style")) continue;
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      parts.push(el.tagName + "." + (typeof el.className === "string" ? el.className : "") + "|" + Math.round(b.width) + "x" + Math.round(b.height) + "@" + Math.round(b.left) + "," + Math.round(b.top) + "|" + props.map(p => cs.getPropertyValue(p)).join(";"));
    }
    out[r] = hash(parts.join("\n")) + ":" + parts.length;
    window.__snapParts = window.__snapParts || {};
    window.__snapParts[r] = parts;
  }
  return out;
};
1;
