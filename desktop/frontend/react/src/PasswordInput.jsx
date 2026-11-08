import { useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";

// A password box with an eye to look at what was typed. It hides the text again when the person leaves the box, so a password is not left
// showing on a screen. Everything else is a plain input: pass it the props an input takes.
export function PasswordInput({ onBlur, ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input">
      <input {...props} type={shown ? "text" : "password"} onBlur={(event) => (setShown(false), onBlur?.(event))} />
      <button
        type="button"
        className="password-eye"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onMouseDown={(event) => event.preventDefault()} // keeps the cursor in the box, so the eye does not count as leaving it
        onClick={() => setShown((current) => !current)}
      >
        {shown ? <EyeSlash size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </span>
  );
}
