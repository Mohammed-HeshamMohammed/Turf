# Sign-in and sign-up pages: what is out of place

**Status:** review only, nothing is fixed yet. Written 2026-11-01 from the live pages (`https://callerwhale.com/signin`, `/signup`), the code (`landing/web/src/AccountPages.jsx`, `session.jsx`, `auth/human-check.jsx`) and the auth service (`services/auth`).

Every item below is **to do**. "Seen" means I saw it on the live page or in a live answer; "Read" means it comes from the code only.

## Must fix

1. **The Apple button is shown, but Apple is not set up.** Seen: `https://auth.callerwhale.com/v1/providers` answers `{"apple":false,"google":true}`, and both pages still show *Sign in/up with Apple*. Read: `AuthForm` writes the Google and Apple buttons by hand (`AccountPages.jsx`, the two `button.google` lines); `session.jsx` already works out which providers the service offers (`auth.providerList`) but the form never uses it. A visitor who taps Apple gets an error. **Do:** show only the providers the service reports (and none of the "or with your email" divider if there are none).

2. **"Forgot password" does not fit the rest of the setup.** Read: it calls `/v1/password/forgot`, and **Firebase sends that email**, not the notification service (the rule is that all mail goes through notifications). The site has **no reset-password page** (`PAGE_PATHS` in `App.jsx` has no such route), so the link in that email lands on Firebase's own hosted page, not on Caller Whale. It is also not behind the human check, and with an empty email box it only complains after the click. **Do:** make auth create its own single-use reset link, send it with a new `password_reset` template in notifications (the same way as the confirmation link), add a `/reset` page, and tell the person plainly when the email is on its way.

3. **The pages say "by invitation" but look open.** Read/seen: the header has a big **Sign up** button, the sign-up page is a normal form, and `AUTH_PUBLIC_SIGNUP=false` in production, so an uninvited person finds out only after filling it in and passing the human check. **Do:** pick one: either explain on the page what happens without an invitation (and keep the form), or check the invitation first (an "enter the email you were invited with" step), and rename the header button if sign-up is not for everyone.

4. **The password rules disagree.** Seen/Read: the page and the auth service enforce **8–4096 characters** (five rules). `docs/plans/callerwhale-launch.md` and `docs/plans/firebase-auth.md` both say **12+ characters** (and say Firebase's password policy is set to 12+). **Do:** decide the real minimum, then make the page, auth, Firebase's policy and the docs say the same thing.

## Should fix

5. **No "confirm password" (and no age) on sign-up.** Read: the form has name, email and password only. You asked earlier for username, email, age, password and confirm password. **Do:** decide which fields are wanted; confirm-password is the usual one to add.

6. **Google and Apple sit above the human check but need its answer.** Read: the buttons call `startProvider(..., humanToken, ...)`, and the widget is below them, so tapping a provider before the widget finishes should fail with a message. Seen: calling the Google start address without a token answers 403. Not tried by clicking. **Do:** put the human check above the buttons, or disable the buttons until it passes.

7. **The human check looks pasted in.** Seen on the sign-in page: the label "Verify you're human" sits above a widget whose own text says "Verify you are human", and the widget is the **dark** Cloudflare theme inside a light card. **Do:** drop the extra label and set the widget's theme to light (or match the site).

8. **No feedback on empty or wrong fields.** Read: the form has `noValidate`, so the `required` marks do nothing; an empty submit goes to the server and one general red message comes back. The name field is optional but not marked as optional. **Do:** show the problem next to the field, and mark optional fields.

9. **After sign-up the page does not say "check your email".** Read: `arrive()` goes straight to the dashboard, which shows a note about the confirmation link (`AccountPages.jsx` around the "Open the confirmation link we sent to" text). Confirmation mail now goes through notifications, so the sign-up page should say where the email was sent, and offer "send it again". **Do:** add that message on the way out of sign-up.

## Checked less well (do these before calling the pages finished)

- **`/signup` screenshot:** the pane would not draw it, so I judged it from the text and the code only. Look at it once by eye.
- **Phone width, dark mode, keyboard use and screen readers:** not looked at.
- **The Google round trip and the second-step screen (code by email, Telegram, approval):** not clicked through on the live site.
- **Footer:** the sign-in screenshot ended at the card, so I did not see whether the footer renders under it.

## Not wrong (so nobody re-checks)

- Header: "Sign in" underlined plus a filled "Sign up" button is a normal pattern.
- The sign-in text "Use the account your invitation was sent to." matches the sign-up text.
- Sign-up is not open at the server (`AUTH_PUBLIC_SIGNUP=false`), so the refusal itself is correct; only the page's wording around it (item 3) is the problem.

---

# Part 2: the flow behind the pages (API calls, human check, security, usage)

Added 2026-11-01 after "the flow of API, human checks, all other security and usage matters feel bad". Same rule: review only, everything is **to do**. "Seen" = measured or tried live; "Read" = from code; "Not verified" = my guess, needs a test.

## The API flow (what happens before the form works)

Seen/Read: opening `/signin` makes these calls **one after another**, each waiting for the last:

1. `gate.callerwhale.com/api/v1/auth/service` (0.39 s): the site asks the **core API** where the auth service is.
2. `auth.callerwhale.com/v1/providers` (0.53 s): which of Google and Apple are on.
3. `auth.callerwhale.com/v1/security` (0.28 s): is the human check on, and its site key.
4. the Cloudflare script, then the widget, then the person ticks a box.
5. only then the sign-in request itself.

That is about 1.2 s of waiting before the human check even starts, and it has three problems:

- **A. Sign-in depends on the core API.** If core-api or the gateway is down, the person gets "Caller Whale's server cannot be reached" and cannot sign in, although auth itself is fine. The auth address is already known to the site at build time (`AUTH_ORIGIN`). **Do:** read the auth address from the build setting, drop call 1, and keep the core API out of the sign-in path.
- **B. Calls 2 and 3 can be one call** (or run at the same time), and can be cached for the session. **Do:** one `/v1/security` answer that carries the provider list and the bot-protection setting.
- **C. Several public API names for one site** (`gate`, `appapi`, `auth`, plus `api` for the waitlist) means several allowed origins in the content security policy and in CORS, and the person's browser talks to all of them. **Do:** decide which addresses the *browser* may ever call (suggest: `auth` and `gate` only) and keep `appapi` and `appapiw` private.

## Human check

- **D. It is a tick-box, on every attempt.** Seen: the widget shows "Verify you are human" with a checkbox. Read: sign-in and sign-up verify it *before* the password is looked at, so every wrong password means ticking again (the page resets it). **Do:** use Turnstile's managed or invisible mode so most people never see it, and verify it only when needed (for example after a failed attempt).
- **E. It guards some doors and not others.** Read: checked on sign-in, sign-up and starting Google/Apple. **Not** checked on: forgot password, resend confirmation email, sending a second-step code by email or Telegram, and the landing API's waitlist and contact forms (those have only a hidden "honeypot" field). **Do:** put it on every action that sends an email or writes a row for an anonymous visitor.
- **F. It fails closed, which is right, but the message is vague.** Read: any Cloudflare error returns "Verify you are human and try again." even when Cloudflare is the problem. **Do:** say "the check could not load, reload and try again" when it is a loading failure (the page already does this for script errors; the server does not).

## Rate limits and lockouts

- **G. The landing API's limit is probably shared by everyone.** Read: `landing/api/src/app.mjs` limits 8 writes a minute per `req.socket.remoteAddress`. Behind Cloudflare and Coolify's proxy that address is the proxy's, the same for every visitor. So the waitlist and contact forms allow **8 requests a minute in total**, not per person. **Do:** use the real client address (the forwarded header from the proxy, trusting only the hops you run), and keep the table small (it never forgets old addresses today).
- **H. Auth has no per-address (IP) limits, only per-email.** Read: auth never looks at the caller's IP (`human.rs` says it does not trust forwarded headers); the lockout is 5 wrong passwords per email in 15 minutes. So someone can **lock a real person out** by failing 5 times on purpose, and nothing slows one machine trying many different emails (the human check is the only brake). **Do:** add a per-IP limit in front of sign-in, sign-up, forgot password and code sending, and make the lockout slow the attacker (delay or human check) instead of blocking the real owner.
- **I. The gateway's per-IP limit may also be shared. Not verified.** Read: `PROXY_HOPS=1` makes the gateway take the address one hop from the end of `X-Forwarded-For`. With Cloudflare in front of Coolify's proxy there are two hops, and Coolify's proxy normally writes its own peer (a Cloudflare address) into that header. If so, everyone behind the same Cloudflare location shares the 600-a-minute bucket. **Do:** send one request through `gate` and log what address the gateway thinks it sees; then set the hop count, or use Cloudflare's own client-address header.

## Where tokens live, and who can reach what

- **J. The refresh token sits in the browser's `localStorage`.** Read: `auth-client.js` keeps it there. Any script that runs on the site can read it. The content security policy (`script-src 'self'` plus Cloudflare's challenge script) is what protects it today, which is a fair defence but a single one. **Do:** consider an `HttpOnly` cookie on the auth address for the refresh token, so scripts cannot read it, and keep access tokens in memory.
- **K. `appapi` and `appapiw` are public names.** Seen: both answer from the internet. Core-api checks tokens itself, and `/internal/jobs/claim` answered 404 from outside, but the gateway's extra filtering (hidden paths, staff-needs-second-step) is skipped for anyone calling `appapi` directly. **Do:** either make those two names private again, or move the gateway's staff and internal-path rules into core-api so there is one set of rules.
- **L. The server's IP is still open on its own.** Seen: it appears in the SPF record and the `inbox` MX, and a direct request to the IP still reaches the server's proxy. **Do:** a firewall on the server that takes web traffic from Cloudflare addresses only.
- **M. DMARC reports go to `dmarc@softfix.dev`.** **Do:** move them to a callerwhale.com address.

## Mail-related security

- **N. Forgot-password email is Firebase's, not notifications'** (also item 2 above). Same for any Firebase-sent email that is left.
- **O. Automated mail still goes out as `magdy@callerwhale.com`**, not `no-reply@`. Replies to a sign-in code would land in a person's mailbox. **Do:** send as `no-reply@` (the notification service needs that mailbox's login) or an alias.

## Usage (credits, limits)

I looked at the *rate* side only (items G, H, I). I did **not** audit credit counting, monthly limits or the usage chart, because "usage" can mean several things and I did not want to guess. **To decide:** which of these feels bad: the credit meter on the dashboard, the monthly limit per invitation, who can raise it, how the desktop app reports use, or the speed limits above. Tell me which and I will trace that one properly.

## Suggested order

1. G, H (limits that are wrong today), then A and B (sign-in no longer depends on the core API).
2. D and E (human check mode and coverage), then item 2 of Part 1 (reset email through notifications).
3. K, L, J (exposure), when you decide how closed `appapi` should be.
