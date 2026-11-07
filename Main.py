import os
from datetime import datetime
from dotenv import load_dotenv
from flask import (
    Flask, render_template, request, redirect,
    url_for, flash, abort
)
from supabase import create_client

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-only-change-me")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError(
        "Missing SUPABASE_URL / SUPABASE_KEY. "
        "Copy .env.example to .env and fill it in."
    )
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
TABLE = "location"
# Display all tasks
@app.route("/")
def index():
    try:
        result = (
            supabase.table(TABLE)
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )
        tasks = result.data or []

    except Exception as e:
        app.logger.error("Supabase read failed: %s", e)
        flash("Could not load your tasks. Check your database settings.", "error")
        tasks = []

    return render_template("index.html", tasks=tasks)

if __name__ == "__main__":
    app.run(debug=True)
