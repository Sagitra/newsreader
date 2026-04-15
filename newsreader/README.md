# News Reader 2

Modern dark-mode news reader. Flask backend + HTML/CSS/JS frontend. Runs locally in your browser.

## Install

```bash
pip install flask feedparser readability-lxml requests beautifulsoup4
```

## Run

```bash
python server.py
```

Opens automatically at `http://localhost:7432`. Press `Ctrl+C` to quit.

## Features

- **RSS + scrape** — add any RSS/Atom feed or site URL
- **Dark mode** — always on, Nexus dark palette
- **Search** — live search across all articles
- **Categories** — sidebar filter, set per source
- **Reader mode** — click any article → clean readable view
- **Save / Read Later** — bookmark articles, view in Saved tab
- **Export .md** — download any article as Markdown
- **Quick-add** — one-click to add popular feeds from source manager

## Good RSS feeds

| Site | RSS URL |
|------|---------|
| Hacker News | https://news.ycombinator.com/rss |
| BBC World | https://feeds.bbci.co.uk/news/rss.xml |
| Ars Technica | https://feeds.arstechnica.com/arstechnica/index |
| The Verge | https://www.theverge.com/rss/index.xml |
| Wired | https://www.wired.com/feed/rss |
| Reuters | https://feeds.reuters.com/reuters/topNews |
| NASA | https://www.nasa.gov/rss/dyn/breaking_news.rss |
| SVT Nyheter | https://www.svt.se/nyheter/rss.xml |

## Data

Stored in `data/` (JSON files, local only):
- `sources.json` — your sources
- `articles.json` — cached articles  
- `saved.json` — bookmarked articles
