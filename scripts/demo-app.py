"""demo-app.py

Purpose: tiny Flask app used to verify Task B (`flask --app scripts/demo-app.py config`).

Contains:
  - app = Flask(__name__) with SECRET_KEY, API_TOKEN, DB_PASSWORD, a nested dict holding
    AWS_KEY, and one normal key. All values are dummies (never real secrets).
  - Expected verification: the new `flask config` CLI command prints JSON with every
    sensitive value (including the nested AWS_KEY) masked and APP_NAME left readable.

Depends on: Flask 3.1.3 installed by scripts/setup-flask.*. Nothing depends on it
except the demo/README steps.
"""
from flask import Flask

app = Flask(__name__)
app.config["SECRET_KEY"] = "dummy-secret-key-not-real"
app.config["API_TOKEN"] = "dummy-api-token-not-real"
app.config["DB_PASSWORD"] = "dummy-db-password-not-real"
app.config["CLOUD"] = {"AWS_KEY": "AKIADUMMYNOTREAL", "REGION": "us-east-1"}
app.config["APP_NAME"] = "contexo-demo"


@app.route("/")
def index():
    return "ok"
