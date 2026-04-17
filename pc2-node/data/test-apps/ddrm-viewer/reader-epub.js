/**
 * EPUB Reader — Reflowable ebook viewer for the dDRM runtime.
 *
 * Renders sanitized HTML (from the WASM EPUB sanitizer) into a sandboxed
 * iframe. The iframe is sandbox="" (no allow-scripts, no allow-same-origin)
 * so the chapter cannot execute JS, read cookies, or issue network requests.
 *
 * Navigation:
 *   - Server returns TOC once via X-Asset-TOC (base64 JSON).
 *   - Each chapter is fetched via /api/storage/lit/secure-view with
 *     mimeType=application/epub+zip and chapter=N (0-indexed).
 *   - Fixed-layout EPUBs trigger a 409 response; caller falls back to
 *     pixel-lock (not handled here).
 *
 * Security:
 *   - Content-Security-Policy enforced server-side via response header.
 *   - Zero-width forensic watermark (buyer address) embedded per chapter
 *     inside text nodes by the WASM sanitizer.
 *   - Diagonal SVG overlay watermark injected as CSS background-image.
 *   - Anchor links with "#epub-link:..." hrefs are intercepted and routed
 *     to the target chapter instead of opening externally.
 *
 * Exports `window.EpubReader` with `open(ctx)` entry point.
 */
(function (global) {
  'use strict';

  var READER_FONT_SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26];
  var STORAGE_KEY = 'ddrm-epub-prefs';

  function loadPrefs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_) { return {}; }
  }

  function savePrefs(prefs) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      }
    } catch (_) { /* private mode or quota */ }
  }

  function decodeBase64Json(b64) {
    if (!b64) return null;
    try {
      var bin = atob(b64);
      return JSON.parse(decodeURIComponent(escape(bin)));
    } catch (_) {
      try { return JSON.parse(atob(b64)); } catch (__) { return null; }
    }
  }

  /**
   * Build a full-page HTML document around a sanitized chapter fragment,
   * injecting the current font-size / theme preferences. The WASM sanitizer
   * already returns a self-contained <!DOCTYPE html> document, so we
   * instead inject a <style> tag on top via postMessage-free DOM rewrite.
   */
  function applyReaderTheme(iframe, prefs) {
    var doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) return;

    var styleId = 'ddrm-reader-theme';
    var existing = doc.getElementById(styleId);
    if (existing) existing.remove();

    var style = doc.createElement('style');
    style.id = styleId;
    style.textContent =
      'html, body {' +
      '  font-size: ' + (prefs.fontSize || 17) + 'px !important;' +
      '  line-height: 1.7 !important;' +
      '  color: ' + (prefs.theme === 'dark' ? '#e6e6e6' : (prefs.theme === 'sepia' ? '#3d2f1e' : '#1a1a1a')) + ' !important;' +
      '  background: ' + (prefs.theme === 'dark' ? '#1a1a1a' : (prefs.theme === 'sepia' ? '#f4ecd8' : '#ffffff')) + ' !important;' +
      '  font-family: Georgia, "Iowan Old Style", serif;' +
      '}' +
      'body {' +
      '  max-width: ' + (prefs.viewportWidth || 680) + 'px;' +
      '  margin: 2.5em auto !important;' +
      '  padding: 0 1.5em !important;' +
      '}' +
      'a { color: ' + (prefs.theme === 'dark' ? '#8ab4f8' : '#2563eb') + '; }';
    (doc.head || doc.documentElement).appendChild(style);
  }

  function interceptInternalLinks(iframe, onNavigate) {
    var doc = iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (href.indexOf('#epub-link:') === 0) {
        onNavigate(href.slice('#epub-link:'.length));
      }
      // All other hrefs are swallowed — nothing leaves the reader.
    }, true);
  }

  function buildToolbar(ctx) {
    var wrap = document.createElement('div');
    wrap.className = 'epub-toolbar';

    var prev = document.createElement('button');
    prev.className = 'epub-nav-btn';
    prev.innerHTML = '&laquo; Prev';
    prev.addEventListener('click', function () { ctx.navigate(ctx.current - 1); });

    var next = document.createElement('button');
    next.className = 'epub-nav-btn';
    next.innerHTML = 'Next &raquo;';
    next.addEventListener('click', function () { ctx.navigate(ctx.current + 1); });

    var indicator = document.createElement('span');
    indicator.className = 'epub-chapter-indicator';

    var tocBtn = document.createElement('button');
    tocBtn.className = 'epub-nav-btn epub-toc-btn';
    tocBtn.innerHTML = 'Contents';
    tocBtn.addEventListener('click', ctx.toggleToc);

    var fontMinus = document.createElement('button');
    fontMinus.className = 'epub-size-btn';
    fontMinus.textContent = 'A-';
    fontMinus.title = 'Smaller text';
    fontMinus.addEventListener('click', function () { ctx.adjustFont(-1); });

    var fontPlus = document.createElement('button');
    fontPlus.className = 'epub-size-btn';
    fontPlus.textContent = 'A+';
    fontPlus.title = 'Larger text';
    fontPlus.addEventListener('click', function () { ctx.adjustFont(1); });

    var themeBtn = document.createElement('button');
    themeBtn.className = 'epub-size-btn';
    themeBtn.title = 'Toggle theme';
    themeBtn.textContent = 'Aa';
    themeBtn.addEventListener('click', ctx.cycleTheme);

    wrap.appendChild(tocBtn);
    wrap.appendChild(prev);
    wrap.appendChild(indicator);
    wrap.appendChild(next);
    wrap.appendChild(fontMinus);
    wrap.appendChild(fontPlus);
    wrap.appendChild(themeBtn);

    ctx.indicator = indicator;
    return wrap;
  }

  function buildTocPanel(ctx) {
    var panel = document.createElement('aside');
    panel.className = 'epub-toc-panel hidden';

    var header = document.createElement('div');
    header.className = 'epub-toc-header';
    header.textContent = 'Table of Contents';
    panel.appendChild(header);

    var list = document.createElement('ol');
    list.className = 'epub-toc-list';
    (ctx.toc || []).forEach(function (entry) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.className = 'epub-toc-entry';
      btn.textContent = entry.title || ('Chapter ' + (entry.chapter_index + 1));
      btn.addEventListener('click', function () {
        ctx.navigate(entry.chapter_index);
        ctx.toggleToc();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    panel.appendChild(list);
    return panel;
  }

  /**
   * Entry point. `ctx` is the shared viewer context: {
   *   container: HTMLElement,
   *   fetchChapter: (index) => Promise<{ html: string, toc: TOC[], title, author }>,
   *   viewportWidth: number,
   *   onError: (title, msg) => void,
   *   onReady: () => void,   // hides spinner, shows container
   * }
   */
  function open(ctx) {
    var prefs = loadPrefs();
    prefs.viewportWidth = ctx.viewportWidth || prefs.viewportWidth || 680;
    prefs.fontSize = prefs.fontSize || 17;
    prefs.theme = prefs.theme || 'light';

    ctx.container.classList.remove('hidden');
    ctx.container.classList.add('epub-reader-ready');
    ctx.container.innerHTML = '';

    var layout = document.createElement('div');
    layout.className = 'epub-layout epub-theme-' + prefs.theme;
    ctx.container.appendChild(layout);

    var iframe = document.createElement('iframe');
    // sandbox="" strips all permissions: no scripts, no same-origin,
    // no form submission, no downloads, no top-navigation.
    iframe.setAttribute('sandbox', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.className = 'epub-iframe';
    iframe.title = 'Ebook reader';

    var state = {
      current: 0,
      toc: [],
      totalChapters: 1,
      iframe: iframe,
      tocPanel: null,
      adjustFont: function (delta) {
        var idx = READER_FONT_SIZES.indexOf(prefs.fontSize);
        if (idx === -1) idx = 3;
        idx = Math.max(0, Math.min(READER_FONT_SIZES.length - 1, idx + delta));
        prefs.fontSize = READER_FONT_SIZES[idx];
        savePrefs(prefs);
        applyReaderTheme(iframe, prefs);
      },
      cycleTheme: function () {
        var order = ['light', 'sepia', 'dark'];
        var i = order.indexOf(prefs.theme);
        prefs.theme = order[(i + 1) % order.length];
        savePrefs(prefs);
        layout.className = 'epub-layout epub-theme-' + prefs.theme;
        applyReaderTheme(iframe, prefs);
      },
      toggleToc: function () {
        if (!state.tocPanel) return;
        state.tocPanel.classList.toggle('hidden');
      },
      navigate: function (idx) {
        if (idx < 0 || idx >= state.totalChapters) return;
        if (idx === state.current && state.current !== 0) return;
        loadChapter(idx);
      },
    };

    var toolbar = buildToolbar(state);
    layout.appendChild(toolbar);

    var readerFrame = document.createElement('div');
    readerFrame.className = 'epub-reader-frame';
    readerFrame.appendChild(iframe);
    layout.appendChild(readerFrame);

    function renderToc() {
      if (state.tocPanel) state.tocPanel.remove();
      state.tocPanel = buildTocPanel(state);
      layout.appendChild(state.tocPanel);
    }

    function updateIndicator() {
      var label = state.toc[state.current] && state.toc[state.current].title
        ? state.toc[state.current].title
        : ('Chapter ' + (state.current + 1));
      state.indicator.textContent = label + ' — ' + (state.current + 1) + ' / ' + state.totalChapters;
    }

    function loadChapter(idx) {
      state.current = idx;
      ctx.fetchChapter(idx).then(function (result) {
        if (result.toc && result.toc.length && !state.toc.length) {
          state.toc = result.toc;
          state.totalChapters = Math.max(result.toc.length, result.totalChapters || 1);
          renderToc();
        } else if (result.totalChapters) {
          state.totalChapters = result.totalChapters;
        }

        var blob = new Blob([result.html], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        if (ctx.blobUrls) ctx.blobUrls.push(url);

        iframe.onload = function () {
          applyReaderTheme(iframe, prefs);
          interceptInternalLinks(iframe, function (targetHref) {
            // Find matching TOC entry by href and navigate to its chapter.
            var hit = (state.toc || []).find(function (e) { return e.href && targetHref.indexOf(e.href) !== -1; });
            if (hit) state.navigate(hit.chapter_index);
          });
          if (ctx.onReady) ctx.onReady();
        };
        iframe.src = url;
        updateIndicator();
      }).catch(function (err) {
        if (ctx.onError) ctx.onError('Chapter load failed', err.message || String(err));
      });
    }

    loadChapter(0);
    return state;
  }

  global.EpubReader = { open: open };
})(window);
