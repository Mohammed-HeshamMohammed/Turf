// A progress bar with a liquid fill: the fill grows to `value` percent (0 to 100) with a soft glow moving through it. With no value it shows
// that work is going on (a band that travels along), for steps whose length is not known. Plain CSS, no animation library; motion is off for
// people who ask for reduced motion (crm.css).
export function LiquidProgress({ value = null, label = "Progress", height = 10 }) {
  const known = typeof value === "number" && Number.isFinite(value);
  const percent = known ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div
      className={"liquid-progress" + (known ? "" : " is-unknown")}
      style={{ height }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(percent) : undefined}
    >
      <div className="liquid-progress-fill" style={known ? { width: percent + "%" } : undefined}>
        <span className="liquid-progress-glow" />
      </div>
    </div>
  );
}
