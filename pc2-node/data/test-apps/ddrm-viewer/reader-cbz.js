/**
 * CBZ Reader — Comic book viewer for the dDRM runtime.
 *
 * Each page is a watermarked JPEG produced by the WASM CBZ renderer.
 * Pages are streamed lazily (current + neighbour prefetch) so that a
 * 200-page trade paperback doesn't detonate the browser tab.
 *
 * Two reading modes:
 *   - single: one page fills the viewport (traditional comic reader)
 *   - scroll: vertical stack of pages (webtoon style)
 *
 * Security:
 *   - Server returns fresh JPEG per page request, forensically watermarked
 *     with buyer address via the shared watermark.rs pipeline.
 *   - Blob URLs are revoked on navigation; right-click menu disabled by
 *     the parent viewer.
 *
 * Exports `window.CbzReader` with `open(ctx)` entry point.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ddrm-cbz-prefs';
  var PREFETCH_RADIUS = 1;

  function loadPrefs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_) { return {}; }
  }

  function savePrefs(prefs) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_) { /* ignore */ }
  }

  function buildToolbar(ctx) {
    var wrap = document.createElement('div');
    wrap.className = 'cbz-toolbar';

    var prev = document.createElement('button');
    prev.className = 'cbz-nav-btn';
    prev.innerHTML = '&laquo; Prev';
    prev.addEventListener('click', function () { ctx.navigate(ctx.current - 1); });

    var next = document.createElement('button');
    next.className = 'cbz-nav-btn';
    next.innerHTML = 'Next &raquo;';
    next.addEventListener('click', function () { ctx.navigate(ctx.current + 1); });

    var indicator = document.createElement('span');
    indicator.className = 'cbz-page-indicator';

    var modeBtn = document.createElement('button');
    modeBtn.className = 'cbz-mode-btn';
    modeBtn.addEventListener('click', ctx.toggleMode);

    wrap.appendChild(prev);
    wrap.appendChild(indicator);
    wrap.appendChild(next);
    wrap.appendChild(modeBtn);

    ctx.indicator = indicator;
    ctx.modeBtn = modeBtn;
    return wrap;
  }

  /**
   * `ctx`: {
   *   container: HTMLElement,
   *   fetchPage: (pageNum) => Promise<Blob>,  // 1-indexed
   *   totalPages: number,
   *   blobUrls: string[],
   *   onError, onReady
   * }
   */
  function open(ctx) {
    var prefs = loadPrefs();
    prefs.mode = prefs.mode || 'single';

    ctx.container.classList.remove('hidden');
    ctx.container.innerHTML = '';

    var layout = document.createElement('div');
    layout.className = 'cbz-layout';
    ctx.container.appendChild(layout);

    var state = {
      current: 1,
      totalPages: ctx.totalPages || 1,
      pageCache: {},   // pageNum → blob URL
      inflight: {},    // pageNum → Promise
      navigate: function (n) {
        if (n < 1 || n > state.totalPages) return;
        state.current = n;
        render();
      },
      toggleMode: function () {
        prefs.mode = prefs.mode === 'single' ? 'scroll' : 'single';
        savePrefs(prefs);
        render();
      },
    };

    var toolbar = buildToolbar(state);
    layout.appendChild(toolbar);

    var stage = document.createElement('div');
    stage.className = 'cbz-stage';
    layout.appendChild(stage);

    function getPageUrl(pageNum) {
      if (state.pageCache[pageNum]) return Promise.resolve(state.pageCache[pageNum]);
      if (state.inflight[pageNum]) return state.inflight[pageNum];
      var p = ctx.fetchPage(pageNum).then(function (blob) {
        var url = URL.createObjectURL(blob);
        if (ctx.blobUrls) ctx.blobUrls.push(url);
        state.pageCache[pageNum] = url;
        delete state.inflight[pageNum];
        return url;
      }).catch(function (err) {
        delete state.inflight[pageNum];
        throw err;
      });
      state.inflight[pageNum] = p;
      return p;
    }

    function prefetchNeighbours() {
      for (var d = 1; d <= PREFETCH_RADIUS; d++) {
        var before = state.current - d;
        var after = state.current + d;
        if (before >= 1) getPageUrl(before).catch(function () {});
        if (after <= state.totalPages) getPageUrl(after).catch(function () {});
      }
    }

    function render() {
      stage.innerHTML = '';
      state.modeBtn.textContent = prefs.mode === 'single' ? 'Scroll view' : 'Page view';

      if (prefs.mode === 'single') {
        renderSingle();
      } else {
        renderScroll();
      }
      updateIndicator();
    }

    function updateIndicator() {
      state.indicator.textContent = 'Page ' + state.current + ' / ' + state.totalPages;
    }

    function renderSingle() {
      var img = document.createElement('img');
      img.className = 'cbz-page cbz-page-single';
      img.alt = 'Page ' + state.current;
      img.draggable = false;
      img.oncontextmenu = function (e) { e.preventDefault(); return false; };
      stage.appendChild(img);

      getPageUrl(state.current).then(function (url) {
        img.src = url;
        if (ctx.onReady) ctx.onReady();
        prefetchNeighbours();
      }).catch(function (err) {
        if (ctx.onError) ctx.onError('Page load failed', err.message || String(err));
      });

      stage.onclick = function (e) {
        var rect = stage.getBoundingClientRect();
        var x = e.clientX - rect.left;
        if (x < rect.width / 2) state.navigate(state.current - 1);
        else state.navigate(state.current + 1);
      };
    }

    function renderScroll() {
      stage.onclick = null;
      var start = Math.max(1, state.current - 2);
      var end = Math.min(state.totalPages, state.current + 6);

      for (var i = start; i <= end; i++) {
        (function (pageNum) {
          var img = document.createElement('img');
          img.className = 'cbz-page cbz-page-scroll';
          img.alt = 'Page ' + pageNum;
          img.loading = 'lazy';
          img.draggable = false;
          img.oncontextmenu = function (e) { e.preventDefault(); return false; };
          img.dataset.page = String(pageNum);
          stage.appendChild(img);

          getPageUrl(pageNum).then(function (url) {
            img.src = url;
            if (pageNum === state.current && ctx.onReady) ctx.onReady();
          }).catch(function () {
            img.alt = 'Page ' + pageNum + ' (failed)';
          });
        })(i);
      }

      // Infinite-scroll: when user nears the last rendered page, extend.
      stage.onscroll = null;
      stage.addEventListener('scroll', function () {
        var lastImg = stage.querySelector('.cbz-page-scroll:last-child');
        if (!lastImg) return;
        var lastPage = parseInt(lastImg.dataset.page || '1', 10);
        if (lastPage < state.totalPages && stage.scrollTop + stage.clientHeight > stage.scrollHeight - 800) {
          var nextEnd = Math.min(state.totalPages, lastPage + 6);
          for (var i = lastPage + 1; i <= nextEnd; i++) {
            (function (pageNum) {
              var img = document.createElement('img');
              img.className = 'cbz-page cbz-page-scroll';
              img.alt = 'Page ' + pageNum;
              img.loading = 'lazy';
              img.draggable = false;
              img.dataset.page = String(pageNum);
              stage.appendChild(img);
              getPageUrl(pageNum).then(function (url) { img.src = url; });
            })(i);
          }
        }
      });
    }

    render();

    // Keyboard shortcuts (delegated to parent viewer's keydown already;
    // this just exposes the nav functions).
    state.handleKey = function (e) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { state.navigate(state.current + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { state.navigate(state.current - 1); e.preventDefault(); }
    };
    document.addEventListener('keydown', state.handleKey);

    return state;
  }

  global.CbzReader = { open: open };
})(window);
