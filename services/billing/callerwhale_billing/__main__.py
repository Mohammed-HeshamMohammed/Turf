"""Runs the billing service.

  python -m callerwhale_billing          serve (applies database setup first)
  python -m callerwhale_billing health   the container's health check
"""

import logging
import os
import sys
import urllib.request

from . import config, db
from .app import create_app
from .store import Store


def health() -> int:
    port = os.environ.get("PORT", "8103")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3) as res:
            return 0 if res.status == 200 else 1
    except OSError:
        return 1


def main() -> int:
    if sys.argv[1:] == ["health"]:
        return health()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    settings = config.load(dict(os.environ))
    if not settings.paddle_webhook_secret:
        logging.warning("PADDLE_WEBHOOK_SECRET is not set: every payment webhook will be refused")
    if not settings.tokens:
        logging.warning("BILLING_TOKENS is not set: no service can reserve minutes or credits")
    pool = db.open_pool(settings.database_url)
    for name in db.apply_setup(pool):
        logging.info("applied database setup %s", name)
    import uvicorn

    uvicorn.run(create_app(settings, Store(pool)), host="0.0.0.0", port=settings.port, access_log=False, proxy_headers=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
