/*
 * 3.0 news feeds: choosing what a news widget reads (server: routes/news-feeds.js, lib/news-feed).
 *
 * The person pastes whatever they have — a feed address, or just the site ("fox6now.com") — and
 * presses Find. The server reads it once and answers with:
 *   - the feed itself, when the address is one;
 *   - the feeds the site advertises (or keeps at /feed, /rss …), by title, to pick from;
 *   - for a site with none: "This site has no feed — build one from the page", with the headlines
 *     it found, so the person sees what the screen will show before choosing it.
 *
 * The choice is { feed_url, feed_mode } ('feed' | 'page'), read back with readFeedPicker(host).
 * Typing an address without pressing Find is still allowed: it is saved as a feed, as before.
 *
 * Used by the widget editor (views/widgets.js) and the Simple view's news task (views/simple-news.js).
 * Everything from the server reaches the page through esc() or textContent.
 */
import { api } from '../api.js';
import { t, tn } from '../i18n.js';
import { esc } from '../utils.js';

/** Words for a server error code (lib/news-feed FeedError codes). */
export function feedErrorText(code, fallback = '') {
  switch (code) {
    case 'bad-url': return t('news.err.bad_url');
    case 'private': return t('news.err.private');
    case 'blocked': return t('news.err.blocked');
    case 'timeout': return t('news.err.timeout');
    case 'too-large': return t('news.err.too_large');
    case 'status': return t('news.err.status');
    case 'not-feed': return t('news.err.not_feed');
    case 'robots': return t('news.err.robots');
    case 'no-items': return t('news.err.no_items');
    case 'rate': return t('news.err.rate');
    case 'redirects': case 'network': return t('news.err.network');
    default: return fallback || t('news.err.network');
  }
}

function sourceText(source) {
  switch (source) {
    case 'jsonld': return t('news.picker.source_jsonld');
    case 'sitemap': return t('news.picker.source_sitemap');
    case 'links': return t('news.picker.source_links');
    default: return '';
  }
}

function itemsHtml(items, max = 5) {
  if (!items || !items.length) return `<p class="simple-muted">${esc(t('news.picker.preview_empty'))}</p>`;
  return `<ul class="news-picker-items">${items.slice(0, max).map((it) => `
    <li>${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="news-picker-noimg" aria-hidden="true">&#128240;</span>'}
      <span>${esc(it.title)}</span></li>`).join('')}</ul>`;
}

/*
 * Pictures come through this server's image proxy (routes/news-feeds.js), which answers 404 when
 * the publisher's picture cannot be had (gone, not an image, the per-site budget). A picture that
 * fails becomes the same placeholder an item without one gets, never a broken-image icon. Listeners,
 * not an onerror attribute: the dashboard's CSP refuses inline handlers.
 */
function placeholderOnError(root) {
  root.querySelectorAll('.news-picker-items img').forEach((img) => img.addEventListener('error', () => {
    const ph = document.createElement('span');
    ph.className = 'news-picker-noimg';
    ph.setAttribute('aria-hidden', 'true');
    ph.textContent = '\u{1F4F0}';
    img.replaceWith(ph);
  }, { once: true }));
}

/**
 * Mount the picker into host. opts: { url, mode, simple, onChange(choice) }.
 * Returns { get(), find() }; the same object is kept on host for readFeedPicker.
 */
export function mountFeedPicker(host, { url = '', mode = 'feed', simple = false, onChange = null } = {}) {
  if (!host) return null;
  const state = { url: String(url || ''), mode: mode === 'page' ? 'page' : 'feed', found: null };
  const uid = `np${Math.random().toString(36).slice(2, 8)}`;
  host.innerHTML = `
    <div class="news-picker${simple ? ' news-picker--simple' : ''}">
      <label for="${uid}Url">${esc(t('news.picker.address'))}</label>
      <div class="news-picker-row">
        <input id="${uid}Url" type="url" class="input" data-np-url autocomplete="off" spellcheck="false" placeholder="https://www.example.com" value="${esc(state.url)}">
        <button type="button" class="btn ${simple ? 'btn-primary' : 'btn-secondary btn-sm'}" data-np-find>${esc(t('news.picker.find'))}</button>
      </div>
      <div class="form-hint news-picker-hint">${esc(t('news.picker.hint'))}</div>
      <p class="news-picker-status" data-np-status role="status"></p>
      <div data-np-results></div>
      <div data-np-preview></div>
    </div>`;
  const input = host.querySelector('[data-np-url]');
  const findBtn = host.querySelector('[data-np-find]');
  const status = host.querySelector('[data-np-status]');
  const results = host.querySelector('[data-np-results]');
  const preview = host.querySelector('[data-np-preview]');
  let seq = 0;

  const changed = () => { if (typeof onChange === 'function') onChange({ feed_url: state.url, feed_mode: state.mode }); };
  const setStatus = (text, kind = '') => { status.textContent = text; status.dataset.kind = kind; };

  async function showPreview() {
    const mine = ++seq;
    if (!state.url) { preview.innerHTML = ''; return; }
    preview.innerHTML = `<p class="simple-muted">${esc(t('news.picker.previewing'))}</p>`;
    try {
      const r = await api.newsPreview(state.url, state.mode);
      if (mine !== seq) return;
      preview.innerHTML = `<div class="news-picker-preview"><div class="news-picker-preview-head">${esc(t('news.picker.preview_title'))}${r.title ? ` &middot; ${esc(r.title)}` : ''}</div>${itemsHtml(r.items)}</div>`;
      placeholderOnError(preview);
    } catch (err) {
      if (mine !== seq) return;
      preview.innerHTML = `<p class="news-picker-error">${esc(feedErrorText(err.code, err.message))}</p>`;
    }
  }

  function choose(choice) {
    state.url = choice.url;
    state.mode = choice.mode;
    input.value = choice.url;
    changed();
  }

  // One feed to choose, its title and address escaped.
  const feedOption = (f, i) => {
    const checked = f.url === state.url && state.mode === 'feed' ? 'checked' : '';
    return `<label><input type="radio" name="${esc(uid)}Pick" value="${i}" ${checked}>
      <span><strong>${esc(f.title || f.url)}</strong><small>${esc(f.url)}</small></span></label>`;
  };

  function drawResults(found) {
    const feeds = found.feeds || [];
    let html = '';
    if (feeds.length) {
      html += `<p class="news-picker-found">${esc(tn('news.picker.found', feeds.length))}</p>
        <div class="simple-choice news-picker-list" role="radiogroup" aria-label="${esc(t('news.picker.found_label'))}">
        ${feeds.map((f, i) => feedOption(f, i)).join('')}
        </div>`;
    } else if (found.page && found.page.available) {
      const p = found.page;
      html += `<div class="news-picker-nofeed">
        <p><strong>${esc(t('news.picker.no_feed'))}</strong></p>
        <p class="simple-muted">${esc(t('news.picker.build_desc'))}</p>
        <div class="simple-choice"><label><input type="radio" name="${uid}Pick" value="page" ${state.mode === 'page' && state.url === found.url ? 'checked' : ''}>
          <span><strong>${esc(t('news.picker.build'))}</strong><small>${esc(sourceText(p.source))}</small></span></label></div>
        ${itemsHtml(p.items)}
      </div>`;
    } else if (found.page) {
      html += `<div class="news-picker-nofeed"><p><strong>${esc(t('news.picker.no_feed'))}</strong></p>
        <p class="news-picker-error">${esc(feedErrorText(found.page.reason, found.page.message))}</p></div>`;
    }
    results.innerHTML = html;
    placeholderOnError(results);
    results.querySelectorAll(`input[name="${uid}Pick"]`).forEach((r) => r.addEventListener('change', () => {
      if (r.value === 'page') { choose({ url: found.url, mode: 'page' }); preview.innerHTML = ''; return; }
      const f = feeds[Number(r.value)];
      if (f) { choose({ url: f.url, mode: 'feed' }); showPreview(); }
    }));
  }

  async function find() {
    const raw = input.value.trim();
    if (!raw) { setStatus(t('news.err.bad_url'), 'error'); return; }
    const mine = ++seq;
    findBtn.disabled = true;
    results.innerHTML = '';
    preview.innerHTML = '';
    setStatus(t('news.picker.finding'));
    try {
      const found = await api.newsDiscover(raw);
      if (mine !== seq) return;
      state.found = found;
      setStatus('');
      drawResults(found);
      // One feed (the address was a feed, or the site has exactly one): that is the answer.
      if ((found.feeds || []).length === 1) {
        choose({ url: found.feeds[0].url, mode: 'feed' });
        const radio = results.querySelector(`input[name="${uid}Pick"]`);
        if (radio) radio.checked = true;
        showPreview();
      } else if (!(found.feeds || []).length && found.page && found.page.available) {
        choose({ url: found.url, mode: 'page' });
        const radio = results.querySelector(`input[name="${uid}Pick"][value="page"]`);
        if (radio) radio.checked = true;
      }
    } catch (err) {
      if (mine !== seq) return;
      setStatus(feedErrorText(err.code, err.message), 'error');
    } finally {
      if (mine === seq) findBtn.disabled = false;
    }
  }

  findBtn.addEventListener('click', find);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
  input.addEventListener('input', () => {
    // A typed address is a feed address until Find says otherwise.
    state.url = input.value.trim();
    state.mode = 'feed';
    results.innerHTML = '';
    preview.innerHTML = '';
    setStatus('');
    changed();
  });

  // An existing choice: show what it reads.
  if (state.url) showPreview();

  const handle = { get: () => ({ feed_url: state.url, feed_mode: state.mode }), find };
  host._feedPicker = handle;
  return handle;
}

/** The picker's choice, { feed_url, feed_mode }, or empty values when none is mounted. */
export function readFeedPicker(host) {
  return host && host._feedPicker ? host._feedPicker.get() : { feed_url: '', feed_mode: 'feed' };
}
