/* ── State ─────────────────────────────────────────────────────────────── */
const state = {
  view: 'all',
  category: 'All',
  search: '',
  articles: [],
  currentArticle: null,
};

// Reader preferences — persisted to localStorage
const PREFS_KEY = 'reader_prefs';
const DEFAULT_PREFS = { font: 'georgia', fontSize: 16, theme: 'dark', width: 'normal' };
let prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };

const QUICK_SOURCES = [
  { name: 'Política Exterior', url: 'https://www.politicaexterior.com/feed/',  type: 'rss', category: 'World' },
  { name: 'Drop Site News',    url: 'https://www.dropsitenews.com/feed',    type: 'rss', category: 'World' },
  { name: 'Hacker News',       url: 'https://news.ycombinator.com/rss',                                     type: 'rss',    category: 'Tech'  },
  { name: 'Ars Technica',      url: 'https://feeds.arstechnica.com/arstechnica/index',                      type: 'rss',    category: 'Tech'  },
  { name: 'The Verge',         url: 'https://www.theverge.com/rss/index.xml',                               type: 'rss',    category: 'Tech'  },
  { name: 'BBC News',          url: 'https://feeds.bbci.co.uk/news/rss.xml',                                type: 'rss',    category: 'World' },
  { name: 'Reuters',           url: 'https://feeds.reuters.com/reuters/topNews',                            type: 'rss',    category: 'World' },
  { name: 'NASA',              url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',                       type: 'rss',    category: 'Science'},
  { name: 'NYT Tech',          url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml',          type: 'rss',    category: 'Tech'  },
];

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── API helpers ──────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg;
    try { msg = (await res.json()).error; } catch { msg = res.statusText; }
    throw new Error(msg || 'Request failed');
  }
  return res.json();
}

/* ── Article list ─────────────────────────────────────────────────────────── */
async function loadArticles() {
  const params = new URLSearchParams({
    view: state.view,
    category: state.category === 'All' ? '' : state.category,
    search: state.search,
  });
  state.articles = await api(`/api/articles?${params}`);
  renderArticleList();
}

function formatRelativeDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date)) return iso.slice(0, 10);
  const now = new Date();
  const diffMs = now - date;
  const diffMins  = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays  = Math.floor(diffMs / 86400000);
  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7)   return `${diffDays}d ago`;
  // Older: show date
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffDays > 365 ? 'numeric' : undefined });
}

function renderArticleList() {
  const list = $('article-list');
  const count = $('article-count');
  const n = state.articles.length;
  count.textContent = `${n} article${n !== 1 ? 's' : ''}`;

  if (n === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35">
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 0-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>
      </svg>
      <p>${state.view === 'saved' ? 'No saved articles yet.' : 'No articles. Click <strong>Refresh</strong> to fetch.'}</p>
    </div>`;
    return;
  }

  const savedIds = new Set(JSON.parse(localStorage.getItem('savedIds') || '[]'));

  list.innerHTML = state.articles.map(a => {
    const isSaved = savedIds.has(a.id);
    const cls = isSaved ? 'saved' : (a.read ? 'read' : '');
    const date = formatRelativeDate(a.published);
    const summary = a.summary
      ? `<p class="card-summary">${esc(a.summary.slice(0, 180))}</p>`
      : '';
    return `
    <button class="article-card ${cls}" data-id="${a.id}" onclick="openArticle('${a.id}')">
      <div class="card-main">
        <div class="card-meta">
          <span class="card-source">${esc(a.source)}</span>
          <span class="card-dot">·</span>
          <span class="card-date">${date}</span>
          <span class="card-cat">${esc(a.category)}</span>
        </div>
        <p class="card-title">${esc(a.title)}</p>
        ${summary}
      </div>
      <div class="card-aside">
        <span class="card-badge-saved">★ Saved</span>
      </div>
    </button>`;
  }).join('');
}

/* ── Reader ───────────────────────────────────────────────────────────────── */
async function openArticle(id) {
  const article = state.articles.find(a => a.id === id);
  if (!article) return;
  state.currentArticle = article;

  // mark read
  api(`/api/articles/${id}/read`, { method: 'POST' }).catch(() => {});
  article.read = true;
  const card = document.querySelector(`.article-card[data-id="${id}"]`);
  if (card && !card.classList.contains('saved')) card.classList.add('read');

  // populate header
  $('reader-title').textContent = article.title;
  $('reader-meta').textContent = `${article.source}  ·  ${article.published ? article.published.slice(0,10) : ''}`;
  $('reader-tags').innerHTML = `
    <span class="reader-tag">${esc(article.category)}</span>
    <span class="reader-tag">${esc(article.source)}</span>
  `;
  // Reset title/tags visibility (may have been hidden by post-header logic)
  $('reader-title').style.display = '';
  $('reader-tags').style.display  = '';
  const rdiv = document.querySelector('.reader-divider');
  if (rdiv) rdiv.style.display = '';
  $('reader-content').innerHTML = `<div class="loader"><div class="spinner"></div><span>Loading…</span></div>`;
  $('btn-export-md').href = `/api/articles/${id}/export`;
  $('btn-export-md').download = article.title.slice(0,40).replace(/\s+/g,'_') + '.md';

  updateSaveButton();
  applyReaderPrefs();   // apply stored prefs before showing
  showModal('reader-modal');

  // fetch rich HTML content
  try {
    const data = await api(`/api/articles/${id}/content`);
    const html = data.html || '';
    if (html.trim()) {
      $('reader-content').innerHTML = html;
      enhanceReaderEmbeds();
      // If content has a full post-header with title, suppress the duplicate toolbar title
      const hasPostHeader = $('reader-content').querySelector('.post-header .post-title');
      $('reader-title').style.display = hasPostHeader ? 'none' : '';
      $('reader-tags').style.display  = hasPostHeader ? 'none' : '';
      $('reader-content').querySelector('.reader-divider')?.remove();
      if (hasPostHeader) {
        // also remove any standalone reader-divider
        const div = document.querySelector('.reader-divider');
        if (div) div.style.display = 'none';
      } else {
        const div = document.querySelector('.reader-divider');
        if (div) div.style.display = '';
      }
      // Open all links in new tab for safety
      $('reader-content').querySelectorAll('a').forEach(a => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
    } else {
      $('reader-content').innerHTML = `<p style="opacity:.5">No readable content found for this article.</p>`;
    }
  } catch (e) {
    $('reader-content').innerHTML = `<p style="opacity:.5">Could not load: ${esc(e.message)}</p>`;
  }
}

function updateSaveButton() {
  const id = state.currentArticle?.id;
  if (!id) return;
  const savedIds = new Set(JSON.parse(localStorage.getItem('savedIds') || '[]'));
  const isSaved = savedIds.has(id);
  $('save-label').textContent = isSaved ? '✓ Saved' : 'Save';
  $('btn-save-article').classList.toggle('active', isSaved);
}

$('btn-save-article').addEventListener('click', async () => {
  const art = state.currentArticle;
  if (!art) return;
  const savedIds = new Set(JSON.parse(localStorage.getItem('savedIds') || '[]'));
  const isSaved = savedIds.has(art.id);
  try {
    if (isSaved) {
      await api(`/api/articles/${art.id}/unsave`, { method: 'POST' });
      savedIds.delete(art.id);
    } else {
      await api(`/api/articles/${art.id}/save`, { method: 'POST' });
      savedIds.add(art.id);
    }
    localStorage.setItem('savedIds', JSON.stringify([...savedIds]));
    updateSaveButton();
    if (state.view === 'saved') loadArticles();
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
});

$('btn-open-browser').addEventListener('click', () => {
  if (state.currentArticle) window.open(state.currentArticle.url, '_blank');
});

function isXStatusUrl(href = '') {
  const value = href.trim().toLowerCase();
  return (
    (value.startsWith('https://x.com/') ||
     value.startsWith('http://x.com/') ||
     value.startsWith('https://twitter.com/') ||
     value.startsWith('http://twitter.com/')) &&
    value.includes('/status/')
  );
}

function normalizeXText(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

function looksLikeXMetaLine(line = '') {
  return /views/i.test(line) && /[·•]/.test(line);
}

function looksLikeXStatsLine(line = '') {
  return /(repl(?:y|ies)|reposts?|likes?)/i.test(line);
}

function looksLikeXAuthorLine(line = '') {
  return /@\w[\w\d_]{0,30}/.test(line);
}

function splitXAuthorLine(line = '') {
  const trimmed = line.trim();
  const compact = trimmed.match(/^(.*?)(@\w[\w\d_]{0,30})$/);
  if (compact) return { name: compact[1].trim(), handle: compact[2].trim() };
  const spaced = trimmed.match(/^(.*?\S)\s+(@\w[\w\d_]{0,30})$/);
  if (spaced) return { name: spaced[1].trim(), handle: spaced[2].trim() };
  return { name: trimmed, handle: '' };
}

function buildXEmbed(anchor) {
  const href = anchor.getAttribute('href') || '';

  // Use innerText split — handles deeply nested Substack/Pencraft divs correctly.
  // childNodes only sees top-level nodes; innerText flattens through all nesting.
  const rawText = (anchor.innerText || anchor.textContent || '').replace(/\r/g, '');
  const lines = rawText
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => {
      if (!l) return false;
      // Skip lines that are only avatar alt text injected by Substack
      if (/^X avatar for @/i.test(l)) return false;
      // Skip very short noise lines (single chars, ellipsis etc)
      if (l.length < 2) return false;
      return true;
    });

  if (lines.length < 2) return null;

  const metaIdx = lines.findIndex(looksLikeXMetaLine);
  const statsIdx = lines.findIndex(looksLikeXStatsLine);
  const bodyEnd = metaIdx !== -1 ? metaIdx : (statsIdx !== -1 ? statsIdx : lines.length);
  if (bodyEnd <= 1) return null;

  // First line should be "Name @handle" — but Substack sometimes puts name and
  // handle on separate lines. Detect and merge them.
  let authorLineIdx = 0;
  let author;
  if (looksLikeXAuthorLine(lines[0])) {
    author = splitXAuthorLine(lines[0]);
    authorLineIdx = 1;
  } else if (lines.length > 1 && looksLikeXAuthorLine(lines[1])) {
    // Name on line 0, handle on line 1
    author = { name: lines[0], handle: lines[1].trim() };
    authorLineIdx = 2;
  } else {
    // Fallback: treat first line as author anyway
    author = splitXAuthorLine(lines[0]);
    authorLineIdx = 1;
  }

  const bodyLines = lines.slice(authorLineIdx, bodyEnd);
  const quoteIdx = bodyLines.findIndex(looksLikeXAuthorLine);

  let mainLines = bodyLines;
  let quoteAuthorLine = '';
  let quoteText = '';
  if (quoteIdx !== -1) {
    // Check if line before handle is a plain name (Substack puts name + handle on separate lines)
    let nameIdx = quoteIdx;
    if (quoteIdx > 0
        && !looksLikeXAuthorLine(bodyLines[quoteIdx - 1])
        && !looksLikeXStatsLine(bodyLines[quoteIdx - 1])
        && !looksLikeXMetaLine(bodyLines[quoteIdx - 1])) {
      nameIdx = quoteIdx - 1;
      quoteAuthorLine = bodyLines[nameIdx] + ' ' + bodyLines[quoteIdx];
    } else {
      quoteAuthorLine = bodyLines[quoteIdx];
    }
    mainLines = bodyLines.slice(0, nameIdx);
    quoteText = bodyLines.slice(quoteIdx + 1).join(' ');
  }

  const mainText = mainLines.join(' ').trim();
  if (!mainText) return null;

  const metaLine = metaIdx !== -1 ? lines[metaIdx] : '';
  // Join all stats lines that follow (Replies / Reposts / Likes may each be on own line)
  let statsLine = '';
  if (statsIdx !== -1) {
    const statsParts = lines.slice(statsIdx).filter(looksLikeXStatsLine);
    statsLine = statsParts.join(' · ');
  }

  const images = Array.from(anchor.querySelectorAll('img'))
    .map(img => ({
      src: img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      width: Number(img.getAttribute('width') || 0),
      height: Number(img.getAttribute('height') || 0),
    }))
    .filter(img => img.src);

  let outerAvatar = null;
  let quoteAvatar = null;
  const media = [];
  images.forEach(img => {
    const isAvatar = /avatar/i.test(img.alt) || Math.max(img.width, img.height) <= 64;
    if (isAvatar && !outerAvatar) outerAvatar = img;
    else if (isAvatar && quoteAuthorLine && !quoteAvatar) quoteAvatar = img;
    else media.push(img);
  });

  const figure = document.createElement('figure');
  figure.className = 'x-embed';

  const link = document.createElement('a');
  link.className = 'x-embed-link';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  figure.appendChild(link);

  const header = document.createElement('div');
  header.className = 'x-embed-header';
  if (outerAvatar) {
    const avatar = document.createElement('img');
    avatar.className = 'x-avatar';
    avatar.src = outerAvatar.src;
    avatar.alt = outerAvatar.alt || `X avatar for ${author.handle || author.name}`;
    avatar.loading = 'lazy';
    header.appendChild(avatar);
  }

  const authorWrap = document.createElement('div');
  authorWrap.className = 'x-author';
  const authorName = document.createElement('strong');
  authorName.className = 'x-author-name';
  authorName.textContent = author.name || author.handle || 'X';
  authorWrap.appendChild(authorName);
  if (author.handle) {
    const authorHandle = document.createElement('span');
    authorHandle.className = 'x-author-handle';
    authorHandle.textContent = author.handle;
    authorWrap.appendChild(authorHandle);
  }
  header.appendChild(authorWrap);

  const badge = document.createElement('span');
  badge.className = 'x-badge';
  badge.textContent = 'X';
  header.appendChild(badge);
  link.appendChild(header);

  const text = document.createElement('p');
  text.className = 'x-text';
  text.textContent = mainText;
  link.appendChild(text);

  media.forEach(imgData => {
    const mediaImg = document.createElement('img');
    mediaImg.className = 'x-media';
    mediaImg.src = imgData.src;
    mediaImg.alt = imgData.alt || 'Embedded image';
    mediaImg.loading = 'lazy';
    link.appendChild(mediaImg);
  });

  if (quoteAuthorLine || quoteText) {
    const quoteAuthor = splitXAuthorLine(quoteAuthorLine);
    const quote = document.createElement('blockquote');
    quote.className = 'x-quote';

    const quoteHeader = document.createElement('div');
    quoteHeader.className = 'x-quote-header';
    if (quoteAvatar) {
      const qAvatar = document.createElement('img');
      qAvatar.className = 'x-quote-avatar';
      qAvatar.src = quoteAvatar.src;
      qAvatar.alt = quoteAvatar.alt || `X avatar for ${quoteAuthor.handle || quoteAuthor.name}`;
      qAvatar.loading = 'lazy';
      quoteHeader.appendChild(qAvatar);
    }

    const quoteAuthorWrap = document.createElement('div');
    quoteAuthorWrap.className = 'x-author';
    const quoteAuthorName = document.createElement('strong');
    quoteAuthorName.className = 'x-author-name';
    quoteAuthorName.textContent = quoteAuthor.name || quoteAuthor.handle || 'Quoted post';
    quoteAuthorWrap.appendChild(quoteAuthorName);
    if (quoteAuthor.handle) {
      const quoteAuthorHandle = document.createElement('span');
      quoteAuthorHandle.className = 'x-author-handle';
      quoteAuthorHandle.textContent = quoteAuthor.handle;
      quoteAuthorWrap.appendChild(quoteAuthorHandle);
    }
    quoteHeader.appendChild(quoteAuthorWrap);
    quote.appendChild(quoteHeader);

    if (quoteText) {
      const quoteBody = document.createElement('p');
      quoteBody.className = 'x-quote-text';
      quoteBody.textContent = quoteText;
      quote.appendChild(quoteBody);
    }

    link.appendChild(quote);
  }

  if (metaLine) {
    const meta = document.createElement('figcaption');
    meta.className = 'x-meta';
    meta.textContent = metaLine;
    link.appendChild(meta);
  }

  if (statsLine) {
    const stats = document.createElement('figcaption');
    stats.className = 'x-stats';
    stats.textContent = statsLine;
    link.appendChild(stats);
  }

  return figure;
}

function enhanceReaderEmbeds() {
  const root = $('reader-content');
  if (!root) return;

  root.querySelectorAll('a[href]').forEach(anchor => {
    if (anchor.classList.contains('x-embed-link')) return;
    if (!isXStatusUrl(anchor.getAttribute('href') || '')) return;

    const embed = buildXEmbed(anchor);
    if (embed) anchor.replaceWith(embed);
  });
}

/* ── Reader Settings ──────────────────────────────────────────────────────── */
$('btn-reader-settings').addEventListener('click', () => {
  const panel = $('reader-settings');
  panel.classList.toggle('open');
  const open = panel.classList.contains('open');
  panel.setAttribute('aria-hidden', !open);
  $('btn-reader-settings').classList.toggle('active', open);
});

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function applyReaderPrefs() {
  const body = $('reader-body');
  // theme
  body.dataset.theme = prefs.theme;
  // font
  body.dataset.font  = prefs.font;
  // width
  body.dataset.width = prefs.width;
  // font size via CSS var
  body.style.setProperty('--rb-font-size', prefs.fontSize + 'px');

  // update size display
  $('size-display').textContent = prefs.fontSize + 'px';

  // sync active buttons
  $$('#opt-font .sopt').forEach(b => b.classList.toggle('active', b.dataset.font === prefs.font));
  $$('#opt-theme .sopt').forEach(b => b.classList.toggle('active', b.dataset.theme === prefs.theme));
  $$('#opt-width .sopt').forEach(b => b.classList.toggle('active', b.dataset.width === prefs.width));
}

// Font
$('opt-font').addEventListener('click', e => {
  const btn = e.target.closest('[data-font]');
  if (!btn) return;
  prefs.font = btn.dataset.font;
  savePrefs();
  applyReaderPrefs();
});

// Theme
$('opt-theme').addEventListener('click', e => {
  const btn = e.target.closest('[data-theme]');
  if (!btn) return;
  prefs.theme = btn.dataset.theme;
  savePrefs();
  applyReaderPrefs();
});

// Width
$('opt-width').addEventListener('click', e => {
  const btn = e.target.closest('[data-width]');
  if (!btn) return;
  prefs.width = btn.dataset.width;
  savePrefs();
  applyReaderPrefs();
});

// Font size
const SIZE_MIN = 12, SIZE_MAX = 26, SIZE_STEP = 1;
$('btn-size-down').addEventListener('click', () => {
  prefs.fontSize = Math.max(SIZE_MIN, prefs.fontSize - SIZE_STEP);
  savePrefs();
  applyReaderPrefs();
});
$('btn-size-up').addEventListener('click', () => {
  prefs.fontSize = Math.min(SIZE_MAX, prefs.fontSize + SIZE_STEP);
  savePrefs();
  applyReaderPrefs();
});

/* ── Refresh ──────────────────────────────────────────────────────────────── */
let refreshing = false;
$('btn-refresh').addEventListener('click', async () => {
  if (refreshing) return;
  refreshing = true;
  const btn = $('btn-refresh');
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px"></div> Refreshing…`;
  setStatus('Fetching feeds…');
  try {
    const res = await api('/api/articles/refresh/sync', { method: 'POST' });
    setStatus(`Updated — ${res.count} articles`);
    await loadArticles();
    await loadCategories();
  } catch (e) {
    setStatus('Error: ' + e.message);
  } finally {
    refreshing = false;
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Refresh`;
  }
});

/* ── Categories sidebar ───────────────────────────────────────────────────── */
async function loadCategories() {
  const cats = await api('/api/categories');
  const nav = $('cat-nav');
  nav.innerHTML = `<p class="nav-label">Categories</p>`;
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (cat === state.category ? ' active' : '');
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      state.category = cat;
      $$('#cat-nav .nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadArticles();
    });
    nav.appendChild(btn);
  });
}

/* ── View toggle ──────────────────────────────────────────────────────────── */
$$('[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    $$('[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadArticles();
  });
});

/* ── Search ───────────────────────────────────────────────────────────────── */
let searchTimer;
$('search-input').addEventListener('input', e => {
  state.search = e.target.value;
  $('btn-clear-search').style.display = state.search ? 'block' : 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadArticles(), 250);
});
$('btn-clear-search').addEventListener('click', () => {
  $('search-input').value = '';
  state.search = '';
  $('btn-clear-search').style.display = 'none';
  loadArticles();
});

/* ── Sources modal ────────────────────────────────────────────────────────── */
$('btn-sources').addEventListener('click', () => {
  openSourcesModal();
});

async function openSourcesModal() {
  window._activeQuickTags = new Set();
  showModal('sources-modal');
  await renderSourcesList();
  renderQuickChips();
  // wire tag input each time modal opens (element may be freshly rendered)
  const tagInput = $('quick-tag-input');
  if (tagInput && !tagInput._wired) {
    tagInput._wired = true;
    tagInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const val = tagInput.value.trim();
        if (val) {
          if (!window._activeQuickTags) window._activeQuickTags = new Set();
          window._activeQuickTags.add(val);
          tagInput.value = '';
          renderQuickChips();
        }
      }
    });
  }
}

async function renderSourcesList() {
  const list = $('sources-list');
  list.innerHTML = `<div class="loader"><div class="spinner"></div></div>`;
  try {
    const sources = await api('/api/sources');
    if (sources.length === 0) {
      list.innerHTML = `<div class="sources-empty">No sources yet. Add one above.</div>`;
      return;
    }
    list.innerHTML = sources.map(s => `
      <div class="source-item ${s.enabled ? '' : 'disabled'}" data-id="${s.id}">
        <div class="source-info">
          <div class="source-name">${esc(s.name)}</div>
          <div class="source-url">${esc(s.url)}</div>
          <div class="source-badges">
            <span class="source-badge">${esc(s.category)}</span>
            <span class="source-badge type-badge">${esc(s.type)}</span>
          </div>
        </div>
        <div class="source-actions">
          <label class="toggle" title="${s.enabled ? 'Disable' : 'Enable'} source">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSource('${s.id}', this.checked)"/>
            <span class="toggle-slider"></span>
          </label>
          <button class="btn-delete" onclick="deleteSource('${s.id}')" title="Remove source">✕</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div class="sources-empty">Error: ${e.message}</div>`;
  }
}

function renderQuickChips() {
  // Tag filter chips — renders sources matching active tags
  const container = $('quick-chips');
  const activeTagSet = window._activeQuickTags || new Set();

  // Build list of unique categories from QUICK_SOURCES
  const allCats = [...new Set(QUICK_SOURCES.map(s => s.category))].sort();

  // Filter sources by active tags (if any), else show all
  const filtered = activeTagSet.size
    ? QUICK_SOURCES.filter(s => activeTagSet.has(s.category))
    : QUICK_SOURCES;

  container.innerHTML =
    // Category tag filters
    allCats.map(cat => {
      const active = activeTagSet.has(cat);
      return `<button class="quick-chip cat-tag ${active ? 'active' : ''}" onclick="toggleQuickTag('${esc(cat)}')">${esc(cat)}</button>`;
    }).join('') +
    // Divider if there are both tags and results
    (filtered.length ? `<span class="chip-divider"></span>` : '') +
    // Source chips
    filtered.map(s => `
      <button class="quick-chip source-chip" onclick="quickAdd(${JSON.stringify(s).replace(/"/g, '&quot;')})">
        <span class="chip-icon">+</span>${esc(s.name)}
      </button>`
    ).join('');
}

window.toggleQuickTag = function(cat) {
  if (!window._activeQuickTags) window._activeQuickTags = new Set();
  if (window._activeQuickTags.has(cat)) {
    window._activeQuickTags.delete(cat);
  } else {
    window._activeQuickTags.add(cat);
  }
  renderQuickChips();
};

async function quickAdd(src) {
  try {
    await api('/api/sources', {
      method: 'POST',
      body: JSON.stringify(src),
    });
    await renderSourcesList();
    await loadCategories();
    setStatus(`Added: ${src.name}`);
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
}

window.toggleSource = async (id, enabled) => {
  try {
    await api(`/api/sources/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
    const item = document.querySelector(`.source-item[data-id="${id}"]`);
    if (item) item.classList.toggle('disabled', !enabled);
    // Refresh article list so disabled sources vanish immediately
    await loadArticles();
    await loadCategories();
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
};

window.deleteSource = async (id) => {
  if (!confirm('Remove this source?')) return;
  try {
    await api(`/api/sources/${id}`, { method: 'DELETE' });
    await renderSourcesList();
    await loadCategories();
  } catch (e) {
    setStatus('Error: ' + e.message);
  }
};

/* ── Feed search / discovery ────────────────────────────────────────────────── */
let feedSearchTimer = null;

$('src-site-url').addEventListener('input', () => {
  clearTimeout(feedSearchTimer);
  const val = $('src-site-url').value.trim();
  if (!val) { hideFeedPicker(); return; }
  feedSearchTimer = setTimeout(() => triggerFeedSearch(val), 700);
});

$('src-site-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    clearTimeout(feedSearchTimer);
    triggerFeedSearch($('src-site-url').value.trim());
  }
});

async function triggerFeedSearch(siteUrl) {
  if (!siteUrl) return;
  $('feed-search-spinner').classList.remove('hidden');
  hideFeedPicker();
  try {
    const feeds = await api(`/api/feeds/search?url=${encodeURIComponent(siteUrl)}`);
    renderFeedPicker(feeds);
  } catch (e) {
    $('feed-picker-label').textContent = 'No feeds found — fill in details manually.';
    $('feed-picker-list').innerHTML = '';
    $('feed-picker').classList.remove('hidden');
  } finally {
    $('feed-search-spinner').classList.add('hidden');
  }
}

function renderFeedPicker(feeds) {
  const picker = $('feed-picker');
  const list   = $('feed-picker-list');
  const label  = $('feed-picker-label');

  if (!feeds || feeds.length === 0) {
    label.textContent = 'No feeds found — fill in details manually.';
    list.innerHTML = '';
    picker.classList.remove('hidden');
    return;
  }

  label.textContent = `${feeds.length} feed${feeds.length > 1 ? 's' : ''} found — pick one:`;
  list.innerHTML = feeds.map((f, i) => {
    const ver = (f.version || 'rss')
      .replace('rss20','RSS 2.0').replace('rss10','RSS 1.0')
      .replace('atom10','Atom 1.0').replace('atom03','Atom 0.3')
      .replace(/https:.*jsonfeed.*\/version\//,'JSON Feed ');
    const bits = [ver, f.item_count ? f.item_count+' items' : '', f.velocity ? f.velocity+'/day' : ''].filter(Boolean).join(' · ');
    return `<button class="feed-result" onclick="pickFeed(${i})">
      <div class="feed-result-main">
        <span class="feed-result-title">${esc(f.title || f.url)}</span>
        <span class="feed-result-url">${esc(f.url)}</span>
        ${f.description ? `<span class="feed-result-desc">${esc(f.description.slice(0,100))}</span>` : ''}
      </div>
      <span class="feed-result-meta">${esc(bits)}</span>
    </button>`;
  }).join('');

  picker.classList.remove('hidden');
  picker._feeds = feeds;
}

window.pickFeed = function(idx) {
  const feeds = $('feed-picker')._feeds;
  if (!feeds || !feeds[idx]) return;
  const f = feeds[idx];
  $$('#feed-picker-list .feed-result').forEach((btn, i) => btn.classList.toggle('selected', i === idx));
  $('src-url').value = f.url;
  if (!$('src-name').value.trim()) $('src-name').value = f.title || '';
  $('src-type').value = 'rss';
};

function hideFeedPicker() {
  const p = $('feed-picker');
  if (p) { p.classList.add('hidden'); $('feed-picker-list').innerHTML = ''; }
}

/* ── Add Source Form ───────────────────────────────────────────────────── */
$('btn-add-source').addEventListener('click', async () => {
  const name = $('src-name').value.trim();
  const url  = $('src-url').value.trim();
  const cat  = $('src-category').value.trim() || 'General';
  const type = $('src-type').value;
  const errEl = $('src-error');

  errEl.textContent = '';
  [$('src-name'), $('src-url')].forEach(el => el.classList.remove('error'));

  if (!name) {
    errEl.textContent = 'Name is required.';
    $('src-name').classList.add('error');
    $('src-name').focus();
    return;
  }
  if (!url) {
    errEl.textContent = 'Feed URL is required.';
    $('src-url').classList.add('error');
    $('src-url').focus();
    return;
  }
  if (!url.startsWith('http')) {
    errEl.textContent = 'URL must start with http:// or https://';
    $('src-url').classList.add('error');
    $('src-url').focus();
    return;
  }

  const btn = $('btn-add-source');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    await api('/api/sources', {
      method: 'POST',
      body: JSON.stringify({ name, url, category: cat, type }),
    });
    $('src-site-url').value = '';
    $('src-name').value = '';
    $('src-url').value = '';
    $('src-category').value = '';
    $('src-type').value = 'rss';
    errEl.textContent = '';
    hideFeedPicker();
    await renderSourcesList();
    await loadCategories();
    setStatus(`Source “${name}” added`);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Source';
  }
});

$('src-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-add-source').click();
});

/* ── Modal helpers ────────────────────────────────────────────────────────── */
function showModal(id) {
  $(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function hideModal(id) {
  $(id).classList.add('hidden');
  document.body.style.overflow = '';
  // collapse settings panel when reader closes
  if (id === 'reader-modal') {
    $('reader-settings').classList.remove('open');
    $('btn-reader-settings').classList.remove('active');
  }
}

$('reader-close').addEventListener('click',    () => hideModal('reader-modal'));
$('reader-backdrop').addEventListener('click', () => hideModal('reader-modal'));
$('sources-close').addEventListener('click',   () => hideModal('sources-modal'));
$('sources-backdrop').addEventListener('click',() => hideModal('sources-modal'));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideModal('reader-modal');
    hideModal('sources-modal');
  }
});

/* ── Status bar ───────────────────────────────────────────────────────────── */
let statusTimer;
function setStatus(msg) {
  $('status-text').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('status-text').textContent = ''; }, 5000);
}

/* ── Utils ────────────────────────────────────────────────────────────────── */
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Init ─────────────────────────────────────────────────────────────────── */
async function init() {
  // apply stored reader prefs immediately so settings buttons start correct
  applyReaderPrefs();
  await Promise.all([loadArticles(), loadCategories()]);
  if (state.articles.length === 0) {
    setStatus('No cached articles — fetching…');
    $('btn-refresh').click();
  }
}

init();
