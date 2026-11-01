import { createContext, useContext, useEffect, useState } from "react";
const Context = createContext({ paused: false, reduced: false, toggle() {} });
const key = "callerwhale-site-motion";
export function MotionProvider({ children }) {
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    try {
      setPaused(localStorage.getItem(key) === "off");
    } catch {
      /* Storage is optional. */
    }
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    setInitialized(true);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (initialized)
      document.documentElement.dataset.motion =
        paused || reduced ? "off" : "on";
  }, [paused, reduced, initialized]);
  const toggle = () =>
    setPaused((value) => {
      try {
        localStorage.setItem(key, value ? "on" : "off");
      } catch {
        /* Storage is optional. */
      }
      return !value;
    });
  return (
    <Context.Provider value={{ paused, reduced, toggle }}>
      {children}
    </Context.Provider>
  );
}
export function MotionToggle() {
  const { paused, reduced, toggle } = useContext(Context);
  return (
    <button
      type="button"
      className="motion-toggle"
      onClick={toggle}
      aria-pressed={paused || reduced}
      disabled={reduced}
      title={
        reduced
          ? "Following your system reduced-motion preference."
          : "Pause or resume decorative page motion."
      }
    >
      {reduced ? "Reduced motion" : paused ? "Resume motion" : "Pause motion"}
    </button>
  );
}
