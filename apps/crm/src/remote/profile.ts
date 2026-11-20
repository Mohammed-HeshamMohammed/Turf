/** Keep the auth account as the source of truth for personal fields. Core supplies workspace access. */
export function mergeAuthProfile(user, profile) {
  if (!profile || profile.id !== user?.id) return user;
  return {
    ...user,
    name: profile.name || user.name,
    email: profile.email || user.email,
    avatar: typeof profile.avatar === "string" ? profile.avatar : "",
    phone: typeof profile.phone === "string" ? profile.phone : "",
    username: typeof profile.username === "string" ? profile.username : "",
    currency: typeof profile.currency === "string" ? profile.currency : "",
    first_name: typeof profile.first_name === "string" ? profile.first_name : "",
    middle_name: typeof profile.middle_name === "string" ? profile.middle_name : "",
    last_name: typeof profile.last_name === "string" ? profile.last_name : "",
  };
}
