"""
feed_manager.py — RSS + scrape feed fetching engine
"""
import json
import re
import time
import hashlib
import threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urljoin

import bleach
import feedparser
import requests
from bs4 import BeautifulSoup
from readability import Document

# Tags + attributes allowed in reader HTML output
_ALLOWED_TAGS = [
    "p", "br", "b", "strong", "i", "em", "u", "s", "strike",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "dl", "dt", "dd",
    "blockquote", "pre", "code",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "img", "figure", "figcaption",
    "hr", "sup", "sub", "div", "span",
    "header", "iframe",
]
_ALLOWED_ATTRS = {
    "a":   ["href", "title", "rel", "class"],
    "img": ["src", "alt", "title", "width", "height", "loading", "class"],
    "td":  ["colspan", "rowspan"],
    "th":  ["colspan", "rowspan"],
    "div": ["class"],
    "span": ["class"],
    "p": ["class"],
    "figure": ["class"],
    "figcaption": ["class"],
    "blockquote": ["class"],
    "strong": ["class"],
    "header": ["class"],
    "iframe": ["src", "width", "height", "frameborder", "allowfullscreen", "allow", "class", "title"],
}

DATA_DIR = Path(__file__).parent / "data"
SOURCES_FILE = DATA_DIR / "sources.json"
ARTICLES_FILE = DATA_DIR / "articles.json"
SAVED_FILE = DATA_DIR / "saved.json"

DATA_DIR.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

_IMAGE_SRC_ATTRS = [
    "src",
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-url",
    "data-image",
    "data-fallback-src",
]
_IMAGE_SRCSET_ATTRS = ["srcset", "data-srcset"]

# ── Sources ────────────────────────────────────────────────────────────────────

DEFAULT_SOURCES = [
    {"id": "politicaexterior", "name": "Política Exterior", "url": "https://www.politicaexterior.com/feed/",   "type": "rss", "category": "World", "enabled": True},
    {"id": "dropsite",         "name": "Drop Site News",   "url": "https://www.dropsitenews.com/feed",         "type": "rss", "category": "World", "enabled": True},
]


def load_sources() -> list[dict]:
    if SOURCES_FILE.exists():
        with open(SOURCES_FILE) as f:
            return json.load(f)
    save_sources(DEFAULT_SOURCES)
    return DEFAULT_SOURCES


def save_sources(sources: list[dict]):
    with open(SOURCES_FILE, "w") as f:
        json.dump(sources, f, indent=2)


def add_source(name: str, url: str, source_type: str = "rss", category: str = "General") -> dict:
    sources = load_sources()
    sid = hashlib.md5(url.encode()).hexdigest()[:8]
    src = {"id": sid, "name": name, "url": url, "type": source_type, "category": category, "enabled": True}
    # avoid dupe
    if not any(s["url"] == url for s in sources):
        sources.append(src)
        save_sources(sources)
    return src


def remove_source(source_id: str):
    sources = [s for s in load_sources() if s["id"] != source_id]
    save_sources(sources)


def toggle_source(source_id: str, enabled: bool):
    sources = load_sources()
    for s in sources:
        if s["id"] == source_id:
            s["enabled"] = enabled
    save_sources(sources)


# ── Articles ───────────────────────────────────────────────────────────────────

def _article_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def load_articles() -> list[dict]:
    if ARTICLES_FILE.exists():
        with open(ARTICLES_FILE) as f:
            return json.load(f)
    return []


def save_articles(articles: list[dict]):
    with open(ARTICLES_FILE, "w") as f:
        json.dump(articles, f, indent=2, default=str)


def load_saved() -> list[dict]:
    if SAVED_FILE.exists():
        with open(SAVED_FILE) as f:
            return json.load(f)
    return []


def save_saved(saved: list[dict]):
    with open(SAVED_FILE, "w") as f:
        json.dump(saved, f, indent=2, default=str)


def save_article(article: dict):
    saved = load_saved()
    if not any(s["id"] == article["id"] for s in saved):
        saved.append(article)
        save_saved(saved)


def unsave_article(article_id: str):
    saved = [a for a in load_saved() if a["id"] != article_id]
    save_saved(saved)


def is_saved(article_id: str) -> bool:
    return any(a["id"] == article_id for a in load_saved())


# ── Fetch ──────────────────────────────────────────────────────────────────────

def fetch_rss(source: dict) -> list[dict]:
    try:
        feed = feedparser.parse(source["url"])
        articles = []
        for entry in feed.entries[:30]:
            url = entry.get("link", "")
            if not url:
                continue
            pub = entry.get("published_parsed") or entry.get("updated_parsed")
            pub_dt = datetime(*pub[:6], tzinfo=timezone.utc).isoformat() if pub else datetime.now(timezone.utc).isoformat()
            summary = entry.get("summary", "")
            # strip HTML from summary
            if summary:
                summary = BeautifulSoup(summary, "html.parser").get_text(" ", strip=True)[:500]
            articles.append({
                "id": _article_id(url),
                "title": entry.get("title", "Untitled").strip(),
                "url": url,
                "summary": summary,
                "published": pub_dt,
                "source": source["name"],
                "source_id": source["id"],
                "category": source["category"],
                "read": False,
            })
        return articles
    except Exception as e:
        print(f"RSS fetch error [{source['name']}]: {e}")
        return []


def fetch_scrape(source: dict) -> list[dict]:
    """Fetch headlines by scraping the page for <a> tags."""
    try:
        r = requests.get(source["url"], headers=HEADERS, timeout=10)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        seen = set()
        articles = []
        base = source["url"].rstrip("/")
        # collect all links with reasonable text length
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True)
            if len(text) < 20 or len(text) > 300:
                continue
            if href.startswith("/"):
                href = base + href
            if not href.startswith("http"):
                continue
            if href in seen:
                continue
            seen.add(href)
            articles.append({
                "id": _article_id(href),
                "title": text,
                "url": href,
                "summary": "",
                "published": datetime.now(timezone.utc).isoformat(),
                "source": source["name"],
                "source_id": source["id"],
                "category": source["category"],
                "read": False,
            })
            if len(articles) >= 30:
                break
        return articles
    except Exception as e:
        print(f"Scrape error [{source['name']}]: {e}")
        return []


def fetch_all_sources(progress_cb=None) -> list[dict]:
    sources = [s for s in load_sources() if s.get("enabled", True)]
    existing = {a["id"]: a for a in load_articles()}
    new_articles = []

    for i, src in enumerate(sources):
        if progress_cb:
            progress_cb(i, len(sources), src["name"])
        if src["type"] == "rss":
            fetched = fetch_rss(src)
        else:
            fetched = fetch_scrape(src)
        for art in fetched:
            if art["id"] in existing:
                # preserve read state
                art["read"] = existing[art["id"]].get("read", False)
            else:
                new_articles.append(art["id"])
            existing[art["id"]] = art

    all_articles = sorted(existing.values(), key=lambda a: a.get("published", ""), reverse=True)
    save_articles(all_articles)
    return all_articles


def mark_read(article_id: str):
    articles = load_articles()
    for a in articles:
        if a["id"] == article_id:
            a["read"] = True
    save_articles(articles)


def _pick_srcset_url(srcset: str) -> str:
    for part in srcset.split(","):
        candidate = part.strip().split(" ")[0]
        if candidate:
            return candidate
    return ""


def _normalize_image_url(base_url: str, raw_url: str) -> str:
    raw_url = (raw_url or "").strip()
    if not raw_url:
        return ""
    if raw_url.startswith("//"):
        return "https:" + raw_url
    return urljoin(base_url, raw_url)


def _extract_img_src(img) -> str:
    for attr in _IMAGE_SRC_ATTRS:
        value = img.get(attr, "")
        if value and not value.startswith("data:image/gif"):
            return value
    for attr in _IMAGE_SRCSET_ATTRS:
        value = img.get(attr, "")
        if value:
            candidate = _pick_srcset_url(value)
            if candidate:
                return candidate
    return ""


def _normalize_article_images(soup: BeautifulSoup, base_url: str):
    for node in soup.select("script, style, noscript, nav, header, footer, aside, form, button"):
        node.decompose()

    for picture in soup.find_all("picture"):
        img = picture.find("img")
        if img:
            picture.replace_with(img)
        else:
            picture.decompose()

    for img in soup.find_all("img"):
        src = _extract_img_src(img)
        if src:
            img["src"] = _normalize_image_url(base_url, src)
            img["loading"] = "lazy"
        else:
            img.decompose()


def _normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _parse_x_author_line(line: str) -> tuple[str, str]:
    match = re.match(r"^(.*?)(@\w[\w\d_]{0,30})$", line.strip())
    if match:
        return match.group(1).strip(), match.group(2).strip()

    match = re.match(r"^(.*?\S)\s+(@\w[\w\d_]{0,30})$", line.strip())
    if match:
        return match.group(1).strip(), match.group(2).strip()

    return line.strip(), ""


def _looks_like_x_author_line(line: str) -> bool:
    return bool(re.search(r"@\w[\w\d_]{0,30}", line or ""))


def _looks_like_x_meta_line(line: str) -> bool:
    return any(sep in line for sep in ("·", "Â·")) and any(token in line for token in ("Views", "AM", "PM"))


def _looks_like_x_stats_line(line: str) -> bool:
    return any(token in line for token in ("Replies", "Reply", "Reposts", "Repost", "Likes", "Like"))


def _is_x_status_url(href: str) -> bool:
    href = (href or "").strip().lower()
    return (
        href.startswith("https://x.com/")
        or href.startswith("http://x.com/")
        or href.startswith("https://twitter.com/")
        or href.startswith("http://twitter.com/")
    ) and "/status/" in href


def _build_x_embed(anchor, href: str):
    lines = [_normalize_space(text) for text in anchor.stripped_strings]
    # Filter noise: empty, single chars, and Substack avatar alt text
    lines = [
        line for line in lines
        if line
        and len(line) >= 2
        and not re.match(r'^X avatar for @', line, re.I)
    ]
    if len(lines) < 2:
        return None

    meta_idx = next((i for i, line in enumerate(lines) if _looks_like_x_meta_line(line)), -1)
    stats_idx = next((i for i, line in enumerate(lines) if _looks_like_x_stats_line(line)), -1)
    body_end = meta_idx if meta_idx != -1 else stats_idx if stats_idx != -1 else len(lines)
    if body_end <= 1:
        return None

    # Substack sometimes puts name on line[0] and handle on line[1] separately
    author_start = 1
    if _looks_like_x_author_line(lines[0]):
        author_name, author_handle = _parse_x_author_line(lines[0])
    elif len(lines) > 1 and _looks_like_x_author_line(lines[1]):
        author_name = lines[0]
        author_handle = lines[1].strip()
        author_start = 2
    else:
        author_name, author_handle = _parse_x_author_line(lines[0])

    body_lines = lines[author_start:body_end]
    # quote_idx is 0-based into body_lines
    # Find the first line that looks like a @handle (quote tweet author)
    quote_handle_idx = next(
        (
            i for i, line in enumerate(body_lines)
            if _looks_like_x_author_line(line)
        ),
        -1,
    )

    main_lines = body_lines
    quote_author = ""
    quote_text = ""
    if quote_handle_idx != -1:
        # Check if the line before the @handle is a plain name (no @),
        # meaning name + handle are on separate lines (Substack layout)
        name_idx = quote_handle_idx
        if (quote_handle_idx > 0
                and not _looks_like_x_author_line(body_lines[quote_handle_idx - 1])
                and not _looks_like_x_stats_line(body_lines[quote_handle_idx - 1])
                and not _looks_like_x_meta_line(body_lines[quote_handle_idx - 1])):
            name_idx = quote_handle_idx - 1
            quote_author = body_lines[name_idx] + " " + body_lines[quote_handle_idx]
        else:
            quote_author = body_lines[quote_handle_idx]
        main_lines = body_lines[:name_idx]
        quote_text = " ".join(body_lines[quote_handle_idx + 1:]).strip()

    main_text = " ".join(main_lines).strip()
    meta_line = lines[meta_idx] if meta_idx != -1 else ""
    # Join all stats lines (Replies, Reposts, Likes may each be on own line)
    if stats_idx != -1:
        stats_parts = [l for l in lines[stats_idx:] if _looks_like_x_stats_line(l) or re.match(r'^\d+\.?\d*[KkMm]?$', l)]
        stats_line = " · ".join(stats_parts) if stats_parts else lines[stats_idx]
    else:
        stats_line = ""

    imgs = []
    for img in anchor.find_all("img"):
        src = _extract_img_src(img)
        if not src:
            continue
        imgs.append({
            "src": src,
            "alt": img.get("alt", ""),
            "width": int(img.get("width", 0) or 0),
            "height": int(img.get("height", 0) or 0),
        })

    if not main_text:
        return None

    outer_avatar = None
    quote_avatar = None
    media = []
    for img in imgs:
        normalized_src = img["src"]
        alt = (img["alt"] or "").lower()
        is_avatar = "avatar" in alt or max(img["width"], img["height"]) <= 64
        item = (normalized_src, img["alt"])
        if is_avatar and not outer_avatar:
            outer_avatar = item
        elif is_avatar and quote_author and not quote_avatar:
            quote_avatar = item
        else:
            media.append(item)

    builder = BeautifulSoup("", "html.parser")
    figure = builder.new_tag("figure", attrs={"class": "x-embed"})
    link = builder.new_tag("a", attrs={"href": href, "rel": "noopener noreferrer", "class": "x-embed-link"})
    figure.append(link)

    header = builder.new_tag("div", attrs={"class": "x-embed-header"})
    if outer_avatar:
        avatar = builder.new_tag(
            "img",
            src=_normalize_image_url(href, outer_avatar[0]),
            alt=outer_avatar[1] or f"X avatar for {author_handle or author_name}",
            loading="lazy",
            **{"class": "x-avatar"},
        )
        header.append(avatar)
    author_wrap = builder.new_tag("div", attrs={"class": "x-author"})
    name = builder.new_tag("strong", attrs={"class": "x-author-name"})
    name.string = author_name or author_handle or "X"
    author_wrap.append(name)
    if author_handle:
        handle = builder.new_tag("span", attrs={"class": "x-author-handle"})
        handle.string = author_handle
        author_wrap.append(handle)
    header.append(author_wrap)
    badge = builder.new_tag("span", attrs={"class": "x-badge"})
    badge.string = "X"
    header.append(badge)
    link.append(header)

    text = builder.new_tag("p", attrs={"class": "x-text"})
    text.string = main_text
    link.append(text)

    for media_src, media_alt in media:
        media_img = builder.new_tag(
            "img",
            src=_normalize_image_url(href, media_src),
            alt=media_alt or "Embedded image",
            loading="lazy",
            **{"class": "x-media"},
        )
        link.append(media_img)

    if quote_author or quote_text:
        quote_name, quote_handle = _parse_x_author_line(quote_author)
        quote = builder.new_tag("blockquote", attrs={"class": "x-quote"})
        quote_header = builder.new_tag("div", attrs={"class": "x-quote-header"})
        if quote_avatar:
            q_avatar = builder.new_tag(
                "img",
                src=_normalize_image_url(href, quote_avatar[0]),
                alt=quote_avatar[1] or f"X avatar for {quote_handle or quote_name}",
                loading="lazy",
                **{"class": "x-quote-avatar"},
            )
            quote_header.append(q_avatar)
        q_author = builder.new_tag("div", attrs={"class": "x-author"})
        q_name = builder.new_tag("strong", attrs={"class": "x-author-name"})
        q_name.string = quote_name or quote_handle or "Quoted post"
        q_author.append(q_name)
        if quote_handle:
            q_handle = builder.new_tag("span", attrs={"class": "x-author-handle"})
            q_handle.string = quote_handle
            q_author.append(q_handle)
        quote_header.append(q_author)
        quote.append(quote_header)
        if quote_text:
            q_text = builder.new_tag("p", attrs={"class": "x-quote-text"})
            q_text.string = quote_text
            quote.append(q_text)
        link.append(quote)

    if meta_line:
        meta = builder.new_tag("figcaption", attrs={"class": "x-meta"})
        meta.string = meta_line
        link.append(meta)
    if stats_line:
        stats = builder.new_tag("figcaption", attrs={"class": "x-stats"})
        stats.string = stats_line
        link.append(stats)

    return figure



# ── Video embed domains ─────────────────────────────────────────────────────

_VIDEO_HOSTS = re.compile(
    r'(youtube\.com/embed|youtu\.be|youtube-nocookie\.com/embed'    r'|player\.vimeo\.com/video'    r'|dailymotion\.com/embed'    r'|rumble\.com/embed'    r'|odysee\.com/\$/embed'    r'|bitchute\.com/embed)',
    re.I,
)


def _normalise_yt_src(src: str) -> str:
    """Convert youtu.be/ID and watch?v=ID links to /embed/ID."""
    # youtu.be/ID
    m = re.match(r'https?://youtu\.be/([\w-]+)', src)
    if m:
        return f'https://www.youtube-nocookie.com/embed/{m.group(1)}'
    # watch?v=ID
    m = re.search(r'[?&]v=([\w-]+)', src)
    if m:
        return f'https://www.youtube-nocookie.com/embed/{m.group(1)}'
    # already /embed/ — swap to nocookie
    src = re.sub(r'https?://www\.youtube\.com/embed/', 'https://www.youtube-nocookie.com/embed/', src)
    return src


def _transform_video_embeds(soup: BeautifulSoup):
    """Replace <iframe> video embeds with a clean <figure class="video-embed"> wrapper.
    Swaps youtube.com for youtube-nocookie.com for privacy.
    Runs on raw page soup BEFORE readability so the figure is preserved.
    """
    for iframe in list(soup.find_all("iframe")):
        src = (iframe.get("src") or iframe.get("data-src") or "").strip()
        if not src or not _VIDEO_HOSTS.search(src):
            iframe.decompose()
            continue

        src = _normalise_yt_src(src)

        builder = BeautifulSoup("", "html.parser")
        figure = builder.new_tag("figure", attrs={"class": "video-embed"})
        new_iframe = builder.new_tag(
            "iframe",
            src=src,
            width="560",
            height="315",
            frameborder="0",
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
            allowfullscreen="",
            loading="lazy",
            attrs={"class": "video-iframe"},
        )
        figure.append(new_iframe)
        iframe.replace_with(figure)


def _extract_post_header(soup: BeautifulSoup):
    """Extract and convert Substack/Pencraft .post-header into a clean
    <header class="post-header"> element.  Returns the element (detached from
    the original soup) or None.  Call on raw page soup BEFORE readability.
    """
    for header_div in list(soup.find_all("div", class_="post-header")):
        builder = BeautifulSoup("", "html.parser")
        header = builder.new_tag("header", attrs={"class": "post-header"})

        # ── Publication / section label ──────────────────────────────────────
        # First <a> inside .post-label
        label_wrap = header_div.find(class_="post-label")
        if label_wrap:
            pub_a = label_wrap.find("a")
            if pub_a:
                label = builder.new_tag("p", attrs={"class": "post-publication"})
                label.string = pub_a.get_text(" ", strip=True)
                header.append(label)

        # ── Title ────────────────────────────────────────────────────────────
        h1 = header_div.find("h1")
        if h1:
            title_el = builder.new_tag("h1", attrs={"class": "post-title"})
            title_el.string = h1.get_text(" ", strip=True)
            header.append(title_el)

        # ── Byline: avatar + name + date ─────────────────────────────────────
        byline = builder.new_tag("div", attrs={"class": "post-byline"})
        has_byline = False

        # Avatar img
        avatar_img = None
        for img in header_div.find_all("img"):
            alt = (img.get("alt") or "").lower()
            w = int(img.get("width") or img.get("height") or 0)
            if "avatar" in alt or w <= 64:
                avatar_img = img
                break
        if avatar_img:
            src = _extract_img_src(avatar_img)
            if src:
                av = builder.new_tag(
                    "img",
                    src=src,
                    alt=avatar_img.get("alt", "Author avatar"),
                    loading="lazy",
                    attrs={"class": "post-author-avatar"},
                )
                byline.append(av)
                has_byline = True

        byline_text = builder.new_tag("div", attrs={"class": "post-byline-text"})

        # Author name — look for an <a> pointing to substack.com/@
        author_name = ""
        for a in header_div.find_all("a", href=True):
            href = a["href"]
            if "substack.com/@" in href or ("/@" in href and "substack" in href):
                author_name = a.get_text(" ", strip=True)
                break
        # Fallback: first .color-pub-primary-text span with an <a>
        if not author_name:
            for span in header_div.find_all("span"):
                a = span.find("a")
                if a:
                    txt = a.get_text(" ", strip=True)
                    if txt and len(txt) < 80:
                        author_name = txt
                        break
        if author_name:
            name_el = builder.new_tag("span", attrs={"class": "post-author-name"})
            name_el.string = author_name
            byline_text.append(name_el)
            has_byline = True

        # Date — small div/span with a date-ish string (e.g. "Mar 30, 2026")
        date_str = ""
        date_pattern = re.compile(
            r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b',
            re.I,
        )
        for el in header_div.find_all(True):
            txt = el.get_text(" ", strip=True)
            if date_pattern.search(txt) and len(txt) < 40:
                date_str = date_pattern.search(txt).group(0)
                break
        if date_str:
            date_el = builder.new_tag("span", attrs={"class": "post-date"})
            date_el.string = date_str
            byline_text.append(date_el)
            has_byline = True

        if has_byline:
            byline.append(byline_text)
            header.append(byline)

        # Remove the original messy div — we've extracted what we need
        header_div.decompose()
        return header  # return first match only

    return None


def _transform_social_embeds(soup: BeautifulSoup):
    for anchor in list(soup.find_all("a", href=True)):
        href = anchor.get("href", "")
        if not _is_x_status_url(href):
            continue
        if len(anchor.find_all("img")) == 0 and len(list(anchor.stripped_strings)) < 3:
            continue
        embed = _build_x_embed(anchor, href)
        if embed:
            anchor.replace_with(embed)


def _content_score(soup: BeautifulSoup) -> tuple[int, int, int]:
    text_len = len(soup.get_text(" ", strip=True))
    images = len(soup.find_all("img"))
    paragraphs = len(soup.find_all("p"))
    # Count video embeds as high-value content (each = 5 imgs)
    video_embeds = len(soup.select("figure.video-embed"))
    return (images + video_embeds * 5, paragraphs, text_len)


def _extract_source_article_soup(page_soup: BeautifulSoup, base_url: str) -> Optional[BeautifulSoup]:
    candidates = []
    for selector in (
        "article",
        "main article",
        "[role='main'] article",
        ".entry-content",
        ".article-body",
        ".article-content",
        ".post-content",
        ".story-body",
        "main",
    ):
        for node in page_soup.select(selector):
            candidate = BeautifulSoup(str(node), "html.parser")
            _normalize_article_images(candidate, base_url)
            if candidate.get_text(" ", strip=True):
                candidates.append(candidate)

    if not candidates:
        return None

    return max(candidates, key=_content_score)


# ── Reader mode ────────────────────────────────────────────────────────────────

def fetch_article_content(url: str) -> dict:
    """Return sanitized HTML + plain text from URL using readability."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=12)
        r.raise_for_status()
        page_soup = BeautifulSoup(r.text, "html.parser")

        # Extract post header BEFORE readability (readability discards it).
        # We'll prepend it manually after readability runs.
        post_header = _extract_post_header(page_soup)

        # Convert video iframes to clean figures before readability runs.
        _transform_video_embeds(page_soup)

        # Transform X embeds on raw page soup BEFORE readability strips them.
        _transform_social_embeds(page_soup)
        pre_processed_html = str(page_soup)

        doc = Document(pre_processed_html)
        raw_html = doc.summary()
        title = doc.title() or ""

        readability_soup = BeautifulSoup(raw_html, "html.parser")
        _normalize_article_images(readability_soup, url)

        source_soup = _extract_source_article_soup(page_soup, url)
        if source_soup and _content_score(source_soup) > _content_score(readability_soup):
            soup = source_soup
        else:
            soup = readability_soup

        # Fix video-embed figures:
        # Readability preserves the <figure class="video-embed"> shell but
        # empties the iframe out of it. Repair by matching empty figures in
        # chosen soup with real figures from page_soup (in order), then
        # appending any extras that readability dropped entirely.
        source_figures = [
            f for f in page_soup.select("figure.video-embed")
            if f.find("iframe")
        ]
        soup_figures = soup.select("figure.video-embed")
        # Pair up: fill empty shells first
        src_iter = iter(source_figures)
        for soup_fig in soup_figures:
            if not soup_fig.find("iframe"):
                try:
                    real_fig = next(src_iter)
                    soup_fig.replace_with(BeautifulSoup(str(real_fig), "html.parser"))
                except StopIteration:
                    break
        # Append any remaining source figures not yet placed
        placed_srcs = {iframe.get("src", "") for iframe in soup.select("figure.video-embed iframe")}
        remaining = [
            f for f in source_figures
            if f.find("iframe") and f.find("iframe").get("src", "") not in placed_srcs
        ]
        if remaining:
            body = soup.find("body") or soup.find("div") or soup
            for fig in remaining:
                body.append(BeautifulSoup(str(fig), "html.parser"))

        # Prepend the extracted post header so it always appears at the top.
        if post_header:
            body = soup.find("body") or soup.find("div") or soup
            body.insert(0, post_header)

        # Also run transform on chosen soup — catches any x.com links that
        # readability preserved but that weren't in the original page embeds.
        _transform_social_embeds(soup)

        clean_html = bleach.clean(
            str(soup),
            tags=_ALLOWED_TAGS,
            attributes=_ALLOWED_ATTRS,
            strip=True,
        )
        # plain text fallback
        plain = soup.get_text("\n", strip=True)
        lines = [l for l in plain.splitlines() if l.strip()]
        plain_text = "\n\n".join(lines)

        return {"html": clean_html, "text": plain_text, "title": title}
    except Exception as e:
        msg = f"Could not load article content: {e}"
        return {"html": f"<p style='opacity:.5'>{msg}</p>", "text": msg, "title": ""}


# ── Export ─────────────────────────────────────────────────────────────────────

def export_article_md(article: dict, content: str) -> str:
    lines = [
        f"# {article['title']}",
        f"",
        f"**Source:** {article['source']}  ",
        f"**Published:** {article['published'][:10]}  ",
        f"**URL:** {article['url']}  ",
        f"**Category:** {article['category']}",
        f"",
        "---",
        f"",
        content,
    ]
    return "\n".join(lines)
