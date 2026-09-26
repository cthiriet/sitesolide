"""Sample API: no static page, everything goes through the service.

Caddy proxies the whole subdomain to this process, with no file_server: that is
the shape the CLI generates when the manifest declares no `publicDir`.
"""

from datetime import UTC, datetime

from fastapi import FastAPI

api = FastAPI(title="sample-api")


@api.get("/")
def home() -> dict[str, str]:
    return {"service": "sample-api", "message": "deployed from another repository"}


@api.get("/api/state")
def state() -> dict[str, str]:
    return {"service": "sample-api", "timestamp": datetime.now(UTC).isoformat()}
