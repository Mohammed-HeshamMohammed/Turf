"""Settings, all from environment variables. Secrets are never in files."""

from dataclasses import dataclass, field

# The services that may call billing's private requests, and what each may do.
CALLER_RIGHTS = {
    "core-api": {"reserve", "standing", "credits", "subscribe"},
    "worker": {"standing"},
    # The auth service reads a summary of revenue, plans and usage for the platform owner's dashboard.
    # ...and, for an owner or cofounder, gives a person a membership: a trial, a free plan, or one paid for outside Paddle.
    "auth": {"summary", "assign", "standing"},  # standing: a workspace's plan and usage, shown to its own members
}


@dataclass(frozen=True)
class Settings:
    port: int = 8103
    database_url: str = ""
    tokens: dict[str, str] = field(default_factory=dict)  # token -> calling service
    paddle_webhook_secret: str = ""
    paddle_tolerance_seconds: int = 300
    authz_url: str = ""
    authz_token: str = ""


class SettingsError(ValueError):
    pass


# A caller may have two tokens at once, so a token can be replaced without a moment where the caller is refused: add the new one,
# switch the caller over, then remove the old one.
TOKENS_PER_CALLER = 2


def parse_tokens(text: str) -> dict[str, str]:
    """BILLING_TOKENS: "core-api=<token>,worker=<token>" (a name may appear twice while its token is being replaced)."""
    tokens: dict[str, str] = {}
    seen: dict[str, int] = {}
    for part in (p.strip() for p in text.split(",")):
        if not part:
            continue
        name, sep, token = (s.strip() for s in part.partition("="))
        if not sep or name not in CALLER_RIGHTS:
            raise SettingsError(f"BILLING_TOKENS: {name!r} is not one of the calling services ({', '.join(sorted(CALLER_RIGHTS))})")
        if len(token) < 32:
            raise SettingsError(f"BILLING_TOKENS: the token for {name} is shorter than 32 characters")
        if token in tokens:
            raise SettingsError(f"BILLING_TOKENS: {name} shares a token with another entry; every token must be different")
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > TOKENS_PER_CALLER:
            raise SettingsError(f"BILLING_TOKENS: {name} has more than {TOKENS_PER_CALLER} tokens; keep the new one and the one being replaced")
        tokens[token] = name
    return tokens


def load(env: dict[str, str]) -> Settings:
    def get(name: str, default: str = "") -> str:
        return (env.get(name) or "").strip() or default

    try:
        port = int(get("PORT", "8103"))
        tolerance = int(get("PADDLE_WEBHOOK_TOLERANCE_SECONDS", "300"))
    except ValueError as error:
        raise SettingsError("PORT and PADDLE_WEBHOOK_TOLERANCE_SECONDS are numbers") from error
    if not 5 <= tolerance <= 3600:
        raise SettingsError("PADDLE_WEBHOOK_TOLERANCE_SECONDS is from 5 to 3600")
    database_url = get("DATABASE_URL")
    if not database_url:
        raise SettingsError("set DATABASE_URL, billing's own PostgreSQL database and login")
    authz_url, authz_token = get("AUTHZ_URL").rstrip("/"), get("AUTHZ_TOKEN")
    if bool(authz_url) != bool(authz_token):
        raise SettingsError("set AUTHZ_URL and AUTHZ_TOKEN together (billing's token in the authorization service)")
    return Settings(
        port=port,
        database_url=database_url,
        tokens=parse_tokens(get("BILLING_TOKENS")),
        paddle_webhook_secret=get("PADDLE_WEBHOOK_SECRET"),
        paddle_tolerance_seconds=tolerance,
        authz_url=authz_url,
        authz_token=authz_token,
    )
