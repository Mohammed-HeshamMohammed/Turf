// Live speech to text from the microphone, through the browser's built-in recogniser (the Web Speech API).
// Chrome and Edge provide it; some webviews do not, so callers check `speechSupported()` first.

const Recognition = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const speechSupported = () => Boolean(Recognition);

/**
 * Starts listening. `onInterim(text)` fires as words arrive, `onFinal(text)` when a phrase is settled,
 * `onState(state)` reports "listening", "denied", "unavailable" or "idle". Returns a function that stops it.
 */
export function startListening({ onInterim, onFinal, onState, lang = "en-US" }) {
  if (!Recognition) {
    onState("unavailable");
    return () => {};
  }
  let wanted = true;
  let recogniser = null;
  const begin = () => {
    recogniser = new Recognition();
    recogniser.continuous = true;
    recogniser.interimResults = true;
    recogniser.lang = lang;
    recogniser.onstart = () => onState("listening");
    recogniser.onresult = event => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0].transcript.trim();
        if (result.isFinal) text && onFinal(text);
        else interim += " " + text;
      }
      onInterim(interim.trim());
    };
    recogniser.onerror = event => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wanted = false;
        onState("denied");
      } else if (event.error === "audio-capture" || event.error === "network") {
        wanted = false;
        onState("unavailable");
      }
    };
    // The recogniser ends itself after a long silence; carry on for as long as the call does.
    recogniser.onend = () => {
      onInterim("");
      if (wanted) {
        try {
          begin();
        } catch {
          onState("unavailable");
        }
      } else onState("idle");
    };
    recogniser.start();
  };
  try {
    begin();
  } catch {
    onState("unavailable");
  }
  return () => {
    wanted = false;
    try {
      recogniser?.stop();
    } catch {
      /* Already stopped. */
    }
    onState("idle");
  };
}
