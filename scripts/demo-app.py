"""demo-app.py

Purpose: tiny Flask app used to verify Task B (`flask --app scripts/demo-app.py config`).

Will contain:
  - app = Flask(__name__) with app.config["SECRET_KEY"] and app.config["API_TOKEN"]
    set to dummy values (never real secrets).
  - Expected verification: the new `flask config` CLI command prints JSON with
    SECRET_KEY and API_TOKEN masked.

Depends on: Flask 3.1.3 installed by scripts/setup-flask.*. Nothing depends on it
except the demo/README steps.
"""
