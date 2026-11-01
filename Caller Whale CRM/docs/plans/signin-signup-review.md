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
