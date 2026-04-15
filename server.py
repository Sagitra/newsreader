"""
server.py — Flask backend for News Reader
"""
import threading
import webbrowser
from pathlib import Path
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory, abort

import feed_manager as fm

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["JSON_SORT_KEYS"] = False

BASE = Path(__file__).parent

# ── Static / SPA ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(BASE / "templates", "index.html")

@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(BASE / "static", path)

# ── Sources API ────────────────────────────────────────────────────────────────

@app.route("/api/sources", methods=["GET"])
def get_sources():
    return jsonify(fm.load_sources())

@app.route("/api/sources", methods=["POST"])
def create_source():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    url  = (data.get("url")  or "").strip()
    cat  = (data.get("category") or "General").strip()
    typ  = data.get("type", "rss")
    if not name or not url:
        return jsonify({"error": "name and url required"}), 400
    if not url.startswith("http"):
        return jsonify({"error": "URL must start with http:// or https://"}), 400
    src = fm.add_source(name, url, typ, cat)
    return jsonify(src), 201

@app.route("/api/sources/<sid>", methods=["DELETE"])
def delete_source(sid):
    fm.remove_source(sid)
    return jsonify({"ok": True})

@app.route("/api/sources/<sid>/toggle", methods=["POST"])
def toggle_source(sid):
    data = request.get_json(force=True)
    fm.toggle_source(sid, data.get("enabled", True))
    return jsonify({"ok": True})

# ── Articles API ───────────────────────────────────────────────────────────────

@app.route("/api/articles", methods=["GET"])
def get_articles():
    category = request.args.get("category", "")
    search   = request.args.get("search", "").lower().strip()
    view     = request.args.get("view", "all")   # all | saved

    if view == "saved":
        articles = fm.load_saved()
    else:
        articles = fm.load_articles()
        # Filter out articles from disabled sources
        enabled_ids = {s["id"] for s in fm.load_sources() if s.get("enabled", True)}
        articles = [a for a in articles if a.get("source_id") in enabled_ids]

    if category and category != "All":
        articles = [a for a in articles if a.get("category") == category]
    if search:
        articles = [
            a for a in articles
            if search in a.get("title", "").lower()
            or search in a.get("summary", "").lower()
            or search in a.get("source", "").lower()
        ]
    return jsonify(articles)

@app.route("/api/articles/refresh", methods=["POST"])
def refresh_articles():
    """Triggers a background refresh; returns immediately."""
    def _run():
        fm.fetch_all_sources()
    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"ok": True, "message": "Refresh started"})

@app.route("/api/articles/refresh/sync", methods=["POST"])
def refresh_articles_sync():
    """Blocking refresh — returns when done."""
    articles = fm.fetch_all_sources()
    return jsonify({"ok": True, "count": len(articles)})

@app.route("/api/articles/<aid>/read", methods=["POST"])
def mark_read(aid):
    fm.mark_read(aid)
    return jsonify({"ok": True})

@app.route("/api/articles/<aid>/save", methods=["POST"])
def save_article(aid):
    articles = fm.load_articles()
    saved_list = fm.load_saved()
    art = next((a for a in articles if a["id"] == aid), None)
    # also check saved list
    if not art:
        art = next((a for a in saved_list if a["id"] == aid), None)
    if not art:
        return jsonify({"error": "not found"}), 404
    fm.save_article(art)
    return jsonify({"ok": True})

@app.route("/api/articles/<aid>/unsave", methods=["POST"])
def unsave_article(aid):
    fm.unsave_article(aid)
    return jsonify({"ok": True})

@app.route("/api/articles/<aid>/saved", methods=["GET"])
def check_saved(aid):
    return jsonify({"saved": fm.is_saved(aid)})

@app.route("/api/articles/<aid>/content", methods=["GET"])
def get_content(aid):
    all_arts = fm.load_articles() + fm.load_saved()
    # deduplicate by id (saved articles may overlap)
    seen = {}
    for a in all_arts:
        seen.setdefault(a["id"], a)
    art = seen.get(aid)
    if not art:
        return jsonify({"error": "not found"}), 404
    result = fm.fetch_article_content(art["url"])
    # result is now {html, text, title}
    return jsonify({"html": result["html"], "text": result["text"], "article": art})

@app.route("/api/articles/<aid>/export", methods=["GET"])
def export_article(aid):
    all_arts = fm.load_articles() + fm.load_saved()
    seen = {}
    for a in all_arts:
        seen.setdefault(a["id"], a)
    art = seen.get(aid)
    if not art:
        return jsonify({"error": "not found"}), 404
    result = fm.fetch_article_content(art["url"])
    md = fm.export_article_md(art, result["text"])
    filename = art["title"][:40].replace(" ", "_").replace("/", "-") + ".md"
    from flask import Response
    return Response(
        md,
        mimetype="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# ── Feed search (feedsearch.dev proxy) ────────────────────────────────────────

@app.route("/api/feeds/search", methods=["GET"])
def search_feeds():
    import requests as req
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url required"}), 400
    try:
        r = req.get(
            "https://feedsearch.dev/api/v1/search",
            params={"url": url, "info": "true", "favicon": "false"},
            timeout=12,
        )
        r.raise_for_status()
        feeds = r.json()
        # Return only what the frontend needs
        slim = [
            {
                "url":         f.get("url", ""),
                "title":       f.get("title") or f.get("site_name") or "",
                "description": f.get("description") or "",
                "version":     f.get("version") or "",
                "item_count":  f.get("item_count") or 0,
                "velocity":    round(f.get("velocity") or 0, 2),
            }
            for f in feeds
            if f.get("url")
        ]
        # Sort by score desc (feedsearch already does this, but ensure)
        return jsonify(slim)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ── Categories ─────────────────────────────────────────────────────────────────

@app.route("/api/categories", methods=["GET"])
def get_categories():
    sources = fm.load_sources()
    cats = sorted(set(s["category"] for s in sources))
    return jsonify(["All"] + cats)


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 7432))
    is_local = port == 7432
    if is_local:
        url = f"http://localhost:{port}"
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
        print(f"\n  News Reader running at {url}\n  Press Ctrl+C to quit.\n")
    host = "localhost" if is_local else "0.0.0.0"
    app.run(host=host, port=port, debug=False, use_reloader=False)
