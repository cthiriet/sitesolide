"""A fixture of bin/tests/cli-infer.test.ts: a Flask app that calls out and
reads a connection string. Never run."""

import os

import requests
from flask import Flask

app = Flask(__name__)


@app.get("/")
def home() -> dict[str, str]:
    database = os.environ.get("DATABASE_URL", "")
    status = requests.get("https://status.example.com", timeout=5).status_code
    return {"database": "set" if database else "missing", "status": str(status)}
