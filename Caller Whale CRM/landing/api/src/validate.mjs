const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Returns { value } or { error } for a waitlist sign-up. */
export function checkWaitlist(body) {
  const email = clean(body?.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return { error: "Enter a valid email address." };
  return {
    value: {
      email,
      name: clean(body?.name, 120),
      company: clean(body?.company, 120),
      tier: ["solo", "duo", "team", "pro"].includes(body?.tier) ? body.tier : "",
    },
  };
}

/** Returns { value } or { error } for a contact message. */
export function checkContact(body) {
  const email = clean(body?.email, 254).toLowerCase();
  const message = clean(body?.message, 4000);
  if (!EMAIL.test(email)) return { error: "Enter a valid email address." };
  if (message.length < 5) return { error: "Write a short message." };
  return { value: { email, name: clean(body?.name, 120), message } };
}
