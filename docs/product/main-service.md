# The main service: dialer, auto dialing and SMS

Calling and texting leads from inside Caller Whale. This is the part people pay for; everything else in the product is there to
make the calling better.

## What it does

- **Click to call:** call a lead from the app, on the desktop, web or mobile app. No phone or other app needed.
- **Auto dialing:** the next lead is called as soon as a call ends, down a list or a queue.
- **Several lines at once:** a caller can dial a few numbers together and is connected to the first person who answers.
- **Texts (SMS):** send and receive texts with a lead, kept as one conversation with the lead's calls and notes.
- **Call log and results:** every call is saved on the lead: when, who called, how long, and what happened.
- **Recording and voicemail detection:** calls can be recorded, and answering machines can be detected so callers only talk to people.
- **Local numbers:** each team picks its own phone numbers, so leads see a number from their area.

## How it is built

Calls and texts go through **Telnyx**, the first phone carrier. Each customer gets its own numbers and settings. Calling rules
(do-not-call lists, calling hours, consent for texts) are part of the product, not left to the caller.

**Status (2026-11-28):** built and tested against a simulator of Telnyx. Not live with real calls yet.
