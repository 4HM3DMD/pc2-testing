/**
 * EPUB Reader — Reflowable ebook viewer for the dDRM runtime.
 *
 * Renders sanitized HTML (from the WASM EPUB sanitizer) into a locked-down
 * iframe. Sandbox is `allow-same-origin` only — explicitly NO `allow-scripts`,
 * NO `allow-forms`, NO `allow-popups`, NO `allow-top-navigation`. Same-origin
 * is granted solely so the parent can drive paged-mode scrolling and toggle
 * themes (the iframe itself cannot execute any JS).
 *
 * Defence in depth against text exfiltration:
 *   1. WASM sanitizer output bakes in `user-select:none`, `::selection`
 *      invisible, `@media print` blackout, and `-webkit-user-drag:none` on
 *      images — unbypassable without dev-tools.
 *   2. CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'` —
 *      no network requests, no external resources.
 *   3. Parent viewer blocks contextmenu + Cmd+S / Cmd+P / PrintScreen.
 *   4. Zero-width forensic watermark in text nodes survives OCR of any
 *      leaked screenshot and traces back to the buyer wallet.
 *
 * Navigation UX:
 *   - Two modes: Scrolling (default — long-form read) or Paged (column-based,
 *     iBooks/Kindle feel). Toggle via 📄 / 📜 button in toolbar.
 *   - Prev/Next advance by page in Paged mode (auto-flip to next chapter at
 *     last column); by chapter in Scrolling mode.
 *   - Keyboard: ← / → step (page or chapter), PgUp / PgDn scroll,
 *     [ / ] jump chapter, f cycles font, t cycles theme.
 *
 * Exports `window.EpubReader` with `open(ctx)` entry point.
 */
(function (global) {
  'use strict';

  var READER_FONT_SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26];
  var STORAGE_KEY = 'ddrm-epub-prefs';
  var PAGE_GAP = 48; // must match column-gap in sanitizer CSS

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

  function safeGetDoc(iframe) {
    try { return iframe.contentDocument || null; }
    catch (_) { return null; }
  }

  /**
   * Apply user-chosen theme / font-size / mode to the iframe content.
   * Runs every time prefs change and after each chapter load.
   */
  function applyReaderState(iframe, prefs, mode) {
    var doc = safeGetDoc(iframe);
    if (!doc || !doc.body) return;

    var body = doc.body;

    body.classList.remove('epub-theme-day', 'epub-theme-night', 'epub-theme-sepia');
    body.classList.add('epub-theme-' + (prefs.theme === 'dark' ? 'night' : (prefs.theme === 'sepia' ? 'sepia' : 'day')));

    body.classList.remove('epub-mode-scroll', 'epub-mode-paged');
    body.classList.add(mode === 'paged' ? 'epub-mode-paged' : 'epub-mode-scroll');

    var styleId = 'ddrm-runtime-style';
    var existing = doc.getElementById(styleId);
    if (existing) existing.remove();

    var style = doc.createElement('style');
    style.id = styleId;
    style.textContent =
      'html,body{font-size:' + (prefs.fontSize || 17) + 'px!important;}' +
      'main.epub-chapter{max-width:' + (prefs.viewportWidth || 680) + 'px;}' +
      (mode === 'paged'
        ? 'html,body{height:100%!important;overflow:hidden!important;}'
        + 'body.epub-mode-paged{column-width:' + (prefs.viewportWidth || 680) + 'px;column-gap:' + PAGE_GAP + 'px;column-fill:auto;height:100vh;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scroll-behavior:smooth;}'
        + 'body.epub-mode-paged main.epub-chapter{scroll-snap-align:start;}'
        : 'html,body{overflow-x:hidden;overflow-y:auto;}');
    (doc.head || doc.documentElement).appendChild(style);
  }

  /**
   * In paged mode: count how many "screens" this chapter is split across,
   * based on columnar layout. Returns { total, current }.
   */
  function paginationInfo(iframe, viewportWidth) {
    var doc = safeGetDoc(iframe);
    if (!doc || !doc.documentElement || !doc.body) return { total: 1, current: 1 };
    if (doc.body.classList.contains('epub-mode-scroll')) return { total: 1, current: 1 };

    var scrollW = doc.documentElement.scrollWidth || doc.body.scrollWidth;
    var clientW = doc.documentElement.clientWidth || doc.body.clientWidth || viewportWidth;
    var colW = viewportWidth + PAGE_GAP;
    var total = Math.max(1, Math.ceil(scrollW / colW));
    var current = Math.min(total, Math.floor((doc.documentElement.scrollLeft + 1) / colW) + 1);
    // Guard against single-screen chapters
    if (scrollW <= clientW + 2) return { total: 1, current: 1 };
    return { total: total, current: current };
  }

  function interceptInternalLinks(iframe, onNavigate) {
    var doc = safeGetDoc(iframe);
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

  function buildToolbar(state) {
    var wrap = document.createElement('div');
    wrap.className = 'epub-toolbar';

    var tocBtn = document.createElement('button');
    tocBtn.className = 'epub-nav-btn epub-toc-btn';
    tocBtn.innerHTML = 'Contents';
    tocBtn.title = 'Table of contents';
    tocBtn.addEventListener('click', state.toggleToc);

    var prev = document.createElement('button');
    prev.className = 'epub-nav-btn';
    prev.innerHTML = '&laquo;';
    prev.title = 'Previous page / chapter (←)';
    prev.addEventListener('click', state.stepBack);

    var indicator = document.createElement('span');
    indicator.className = 'epub-chapter-indicator';
    indicator.title = 'Current location';

    var next = document.createElement('button');
    next.className = 'epub-nav-btn';
    next.innerHTML = '&raquo;';
    next.title = 'Next page / chapter (→)';
    next.addEventListener('click', state.stepForward);

    var modeBtn = document.createElement('button');
    modeBtn.className = 'epub-nav-btn epub-mode-btn';
    modeBtn.title = 'Toggle paged / scrolling mode';
    modeBtn.addEventListener('click', state.toggleMode);

    var fontMinus = document.createElement('button');
    fontMinus.className = 'epub-size-btn';
    fontMinus.textContent = 'A-';
    fontMinus.title = 'Smaller text';
    fontMinus.addEventListener('click', function () { state.adjustFont(-1); });

    var fontPlus = document.createElement('button');
    fontPlus.className = 'epub-size-btn';
    fontPlus.textContent = 'A+';
    fontPlus.title = 'Larger text';
    fontPlus.addEventListener('click', function () { state.adjustFont(1); });

    var themeBtn = document.createElement('button');
    themeBtn.className = 'epub-size-btn';
    themeBtn.title = 'Cycle theme (light / sepia / dark)';
    themeBtn.textContent = 'Aa';
    themeBtn.addEventListener('click', state.cycleTheme);

    wrap.appendChild(tocBtn);
    wrap.appendChild(prev);
    wrap.appendChild(indicator);
    wrap.appendChild(next);
    wrap.appendChild(modeBtn);
    wrap.appendChild(fontMinus);
    wrap.appendChild(fontPlus);
    wrap.appendChild(themeBtn);

    state.indicator = indicator;
    state.modeBtn = modeBtn;
    return wrap;
  }

  function buildTocPanel(state) {
    var panel = document.createElement('aside');
    panel.className = 'epub-toc-panel hidden';

    var header = document.createElement('div');
    header.className = 'epub-toc-header';
    header.textContent = 'Table of Contents';
    panel.appendChild(header);

    var list = document.createElement('ol');
    list.className = 'epub-toc-list';
    (state.toc || []).forEach(function (entry) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.className = 'epub-toc-entry';
      btn.textContent = entry.title || ('Chapter ' + (entry.chapter_index + 1));
      btn.addEventListener('click', function () {
        state.navigate(entry.chapter_index);
        state.toggleToc();
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
   *   fetchChapter: (index) => Promise<{ html, toc, title, author, totalChapters }>,
   *   viewportWidth: number,
   *   onError: (title, msg) => void,
   *   onReady: () => void,
   * }
   */
  function open(ctx) {
    var prefs = loadPrefs();
    prefs.viewportWidth = ctx.viewportWidth || prefs.viewportWidth || 680;
    prefs.fontSize = prefs.fontSize || 17;
    prefs.theme = prefs.theme || 'light';
    // Default to Paged mode (user feedback: feels like a real ebook reader).
    prefs.mode = prefs.mode || 'paged';

    ctx.container.classList.remove('hidden');
    ctx.container.classList.add('epub-reader-ready');
    ctx.container.innerHTML = '';

    var layout = document.createElement('div');
    layout.className = 'epub-layout epub-theme-' + prefs.theme + ' epub-mode-' + prefs.mode;
    ctx.container.appendChild(layout);

    var iframe = document.createElement('iframe');
    // `allow-same-origin` lets the parent reach into the iframe DOM to apply
    // theme prefs and drive paged-mode scroll. All other sandbox features
    // remain disabled: NO scripts, NO forms, NO popups, NO top-navigation,
    // NO downloads. CSP (set by /lit/secure-view) further blocks all
    // network requests except `data:` URIs.
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.className = 'epub-iframe';
    iframe.title = 'Ebook reader';

    var state = {
      current: 0,
      toc: [],
      totalChapters: 1,
      iframe: iframe,
      tocPanel: null,
      mode: prefs.mode,

      adjustFont: function (delta) {
        var idx = READER_FONT_SIZES.indexOf(prefs.fontSize);
        if (idx === -1) idx = 3;
        idx = Math.max(0, Math.min(READER_FONT_SIZES.length - 1, idx + delta));
        prefs.fontSize = READER_FONT_SIZES[idx];
        savePrefs(prefs);
        applyReaderState(iframe, prefs, state.mode);
        updateIndicator();
      },

      cycleTheme: function () {
        var order = ['light', 'sepia', 'dark'];
        var i = order.indexOf(prefs.theme);
        prefs.theme = order[(i + 1) % order.length];
        savePrefs(prefs);
        layout.className = 'epub-layout epub-theme-' + prefs.theme + ' epub-mode-' + state.mode;
        applyReaderState(iframe, prefs, state.mode);
      },

      toggleMode: function () {
        state.mode = state.mode === 'paged' ? 'scroll' : 'paged';
        prefs.mode = state.mode;
        savePrefs(prefs);
        layout.className = 'epub-layout epub-theme-' + prefs.theme + ' epub-mode-' + state.mode;
        applyReaderState(iframe, prefs, state.mode);
        // Reset scroll to start of chapter after mode change so the reader
        // doesn't land in the middle of the content.
        var doc = safeGetDoc(iframe);
        if (doc && doc.documentElement) {
          doc.documentElement.scrollLeft = 0;
          doc.documentElement.scrollTop = 0;
        }
        updateModeButton();
        updateIndicator();
      },

      toggleToc: function () {
        if (!state.tocPanel) return;
        state.tocPanel.classList.toggle('hidden');
      },

      navigate: function (idx) {
        if (idx < 0 || idx >= state.totalChapters) return;
        if (idx === state.current && idx !== 0) return;
        loadChapter(idx);
      },

      /**
       * Step forward: in Paged mode, scroll one column right; when at end of
       * chapter, advance to next chapter. In Scroll mode, next chapter.
       */
      stepForward: function () {
        if (state.mode === 'paged') {
          var doc = safeGetDoc(iframe);
          if (doc && doc.documentElement) {
            var el = doc.documentElement;
            var colW = prefs.viewportWidth + PAGE_GAP;
            var atEnd = el.scrollLeft + el.clientWidth + 8 >= el.scrollWidth;
            if (!atEnd) {
              el.scrollLeft += colW;
              setTimeout(updateIndicator, 120);
              return;
            }
          }
        }
        if (state.current + 1 < state.totalChapters) state.navigate(state.current + 1);
      },

      stepBack: function () {
        if (state.mode === 'paged') {
          var doc = safeGetDoc(iframe);
          if (doc && doc.documentElement) {
            var el = doc.documentElement;
            var colW = prefs.viewportWidth + PAGE_GAP;
            if (el.scrollLeft > 2) {
              el.scrollLeft = Math.max(0, el.scrollLeft - colW);
              setTimeout(updateIndicator, 120);
              return;
            }
          }
        }
        if (state.current > 0) state.navigate(state.current - 1);
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

    function updateModeButton() {
      if (!state.modeBtn) return;
      state.modeBtn.textContent = state.mode === 'paged' ? 'Scroll' : 'Paged';
      state.modeBtn.title = state.mode === 'paged'
        ? 'Switch to continuous scrolling (long-form read)'
        : 'Switch to paged mode (Kindle / iBooks feel)';
    }

    function updateIndicator() {
      if (!state.indicator) return;
      var chapterTitle = state.toc[state.current] && state.toc[state.current].title
        ? state.toc[state.current].title
        : ('Chapter ' + (state.current + 1));
      var chapterLabel = chapterTitle + ' · Chapter ' + (state.current + 1) + ' of ' + state.totalChapters;
      if (state.mode === 'paged') {
        var pg = paginationInfo(iframe, prefs.viewportWidth);
        if (pg.total > 1) {
          chapterLabel = 'Page ' + pg.current + ' of ' + pg.total + ' · ' + chapterTitle + ' (' + (state.current + 1) + '/' + state.totalChapters + ')';
        }
      }
      state.indicator.textContent = chapterLabel;
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
          applyReaderState(iframe, prefs, state.mode);
          interceptInternalLinks(iframe, function (targetHref) {
            var hit = (state.toc || []).find(function (e) { return e.href && targetHref.indexOf(e.href) !== -1; });
            if (hit) state.navigate(hit.chapter_index);
          });
          // Re-compute paged indicator after columns settle (scrollWidth
          // isn't final until fonts + images load).
          setTimeout(updateIndicator, 80);
          setTimeout(updateIndicator, 400);

          // Belt-and-braces: if contentDocument IS reachable, also install
          // keydown/contextmenu blockers inside the iframe.
          var doc = safeGetDoc(iframe);
          if (doc) {
            doc.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            doc.addEventListener('copy', function (e) { e.preventDefault(); });
            doc.addEventListener('cut', function (e) { e.preventDefault(); });
            doc.addEventListener('keydown', function (e) {
              if (!e || !e.key) return;
              // Forward navigation keys to the parent state machine.
              if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); state.stepForward(); }
              else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); state.stepBack(); }
              else if (e.key === '[') { e.preventDefault(); state.navigate(Math.max(0, state.current - 1)); }
              else if (e.key === ']') { e.preventDefault(); state.navigate(Math.min(state.totalChapters - 1, state.current + 1)); }
            });
            // Recompute pagination on scroll (Paged mode page indicator).
            doc.addEventListener('scroll', function () {
              if (state.mode === 'paged') updateIndicator();
            }, { passive: true });
          }

          if (ctx.onReady) ctx.onReady();
        };
        iframe.src = url;
        updateIndicator();
        updateModeButton();
      }).catch(function (err) {
        if (ctx.onError) ctx.onError('Chapter load failed', err.message || String(err));
      });
    }

    // Parent-level keyboard shortcuts (fire when reader has focus but not
    // necessarily the iframe — e.g. user clicked toolbar then pressed →).
    layout.addEventListener('keydown', function (e) {
      if (!e || !e.key) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); state.stepForward(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); state.stepBack(); }
      else if (e.key === '[') { e.preventDefault(); state.navigate(Math.max(0, state.current - 1)); }
      else if (e.key === ']') { e.preventDefault(); state.navigate(Math.min(state.totalChapters - 1, state.current + 1)); }
    });
    layout.setAttribute('tabindex', '0');

    // Recompute paged indicator on window resize (viewport width changes
    // column count).
    global.addEventListener('resize', function () {
      if (state.mode === 'paged') updateIndicator();
    });

    loadChapter(0);
    return state;
  }

  global.EpubReader = { open: open };
})(window);
