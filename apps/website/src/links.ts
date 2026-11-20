// Small readers for the address, kept apart so they can be tested.

/** One value from a query string such as "?email=a%40b.com", or an empty text. */
export function paramOf(search: string, name: string): string {
  return new URLSearchParams(search).get(name) ?? "";
}

/** True when the CRM web app sent the person here to sign in (it adds ?next=app) and expects them back with a one-time code. */
export function wantsCrm(search: string): boolean {
  return paramOf(search, "next") === "app";
}
