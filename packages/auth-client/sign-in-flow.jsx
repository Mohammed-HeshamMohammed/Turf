import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createSignInFlow } from "./sign-in-flow.js";

export { needsCode } from "./sign-in-flow.js";

/**
 * The sign-in steps for a React screen: `[state, flow]`. The screen is the app's own; this only holds the steps. A step left by a
 * refresh comes back when the screen opens.
 */
export function useSignInFlow({ onSignedIn, ...options }) {
  const done = useRef(onSignedIn);
  done.current = onSignedIn;
  const [flow] = useState(() => createSignInFlow({ ...options, onSignedIn: () => done.current?.() }));
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  useEffect(() => {
    flow.restore();
    return () => flow.stop();
  }, [flow]);
  return [state, flow];
}
