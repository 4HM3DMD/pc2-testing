/**
 * dDRM Viewer — Secure runtime for dDRM-protected digital assets.
 *
 * Receives asset params via URL query string or puter.args JSON,
 * calls /api/storage/lit/secure-view to decrypt and render content
 * server-side, then displays the rendered output.
 *
 * - Images: centered fit-contain display
 * - Text / PDF: full-width scrollable document view (all pages stacked)
 */
(function () {
  'use strict';

  var AUTH_TOKEN = (function () {
    try {
      var p = new URLSearchParams(window.location.search);
      return p.get('puter.auth.token') || p.get('auth_token') || p.get('token') || '';
    } catch (_) { return ''; }
  })();

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (AUTH_TOKEN && !opts.headers['Authorization']) {
      opts.headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
    }
    if (!opts.credentials) opts.credentials = 'include';
    return fetch(url, opts);
  }

  // ── DOM refs ──────────────────────────────────────────

  var $title        = document.getElementById('viewer-title');
  var $subtitle     = document.getElementById('viewer-subtitle');
  var $loading      = document.getElementById('loading-state');
  var $loadingText  = document.getElementById('loading-text');
  var $error        = document.getElementById('error-state');
  var $errorTitle   = document.getElementById('error-title');
  var $errorMsg     = document.getElementById('error-message');
  var $content      = document.getElementById('content-area');
  var $imgContainer = document.getElementById('image-container');
  var $img          = document.getElementById('rendered-image');
  var $docContainer = document.getElementById('document-container');
  var $rendererBdg  = document.getElementById('renderer-badge');
  var $watermarkBdg = document.getElementById('watermark-badge');
  var $pageCounter  = document.getElementById('page-counter');
  var $assetType    = document.getElementById('asset-type');

  // Toolbar refs
  var $toolbar      = document.getElementById('viewer-toolbar');
  var $zoomLevel    = document.getElementById('zoom-level');
  var $btnZoomIn    = document.getElementById('btn-zoom-in');
  var $btnZoomOut   = document.getElementById('btn-zoom-out');
  var $btnFullscreen = document.getElementById('btn-fullscreen');
  var $pageNav      = document.getElementById('toolbar-page-nav');
  var $pageIndicator = document.getElementById('page-indicator');
  var $btnPagePrev  = document.getElementById('btn-page-prev');
  var $btnPageNext  = document.getElementById('btn-page-next');

  // ── Parse launch params ───────────────────────────────

  var params = new URLSearchParams(window.location.search);

  var puterArgs = (function () {
    try {
      var raw = params.get('puter.args');
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  })();

  function p(key, fallback) {
    return puterArgs[key] || params.get(key) || fallback;
  }

  var assetParams = {
    litCiphertext:     p('litCiphertext', ''),
    dataToEncryptHash: p('dataToEncryptHash', ''),
    encryptedDataCid:  p('encryptedDataCid', ''),
    iv:                p('iv', ''),
    kid:               p('kid', ''),
    buyerAddress:      p('buyerAddress', ''),
    mimeType:          p('mimeType', 'application/octet-stream'),
    actionCid:         p('actionCid', ''),
    authority:         p('authority', ''),
    title:             p('title', ''),
    maxWidth:          Math.min(window.innerWidth * (window.devicePixelRatio || 1), 1600),
  };

  // ── Helpers ───────────────────────────────────────────

  var isDocumentType = assetParams.mimeType === 'application/pdf'
    || assetParams.mimeType.indexOf('text/') === 0;
  var isAudioType = assetParams.mimeType.indexOf('audio/') === 0;

  // Audio DOM refs
  var $audioContainer = document.getElementById('audio-container');
  var $audioEl        = document.getElementById('audio-element');
  var $audioTitle     = document.getElementById('audio-title');
  var $btnAudioPlay   = document.getElementById('btn-audio-play');
  var $audioPlayIcon  = document.getElementById('audio-play-icon');
  var $audioPauseIcon = document.getElementById('audio-pause-icon');
  var $audioTime      = document.getElementById('audio-time');
  var $audioSeek      = document.getElementById('audio-seek');
  var $audioVolume    = document.getElementById('audio-volume');

  // ── State ─────────────────────────────────────────────

  var viewerState = {
    totalPages: 1,
    pagesLoaded: 0,
  };

  var zoom = { level: 1, min: 0.25, max: 5, step: 0.25 };
  var pan = { active: false, startX: 0, startY: 0, scrollX: 0, scrollY: 0 };
  var imgBaseWidth = 0;
  var currentPage = 1;
  var toolbarTimer = null;

  // ── Init ──────────────────────────────────────────────

  function init() {
    if (assetParams.title) {
      $title.textContent = assetParams.title;
      document.title = assetParams.title + ' — dDRM Viewer';
    }

    $subtitle.textContent = humanMime(assetParams.mimeType);
    $assetType.textContent = assetParams.mimeType;

    disableContextMenu();

    if (!assetParams.encryptedDataCid || !assetParams.kid) {
      showError('Missing Parameters', 'This viewer requires asset parameters to be provided via the launch URL.');
      return;
    }

    loadFirstPage();
  }

  // ── Secure view request ───────────────────────────────

  function buildBody(page) {
    var body = {
      litCiphertext:     assetParams.litCiphertext,
      dataToEncryptHash: assetParams.dataToEncryptHash,
      encryptedDataCid:  assetParams.encryptedDataCid,
      iv:                assetParams.iv,
      kid:               assetParams.kid,
      buyerAddress:      assetParams.buyerAddress,
      mimeType:          assetParams.mimeType,
      maxWidth:          assetParams.maxWidth,
      page:              page,
    };
    if (assetParams.actionCid) body.actionCid = assetParams.actionCid;
    if (assetParams.authority) body.authority = assetParams.authority;
    if (assetParams.litBackend) body.litBackend = assetParams.litBackend;
    return body;
  }

  function loadFirstPage() {
    $loadingText.textContent = 'Verifying access rights...';
    showLoading();

    authFetch('/api/storage/lit/secure-view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(1)),
    })
    .then(function (resp) {
      if (!resp.ok) {
        return resp.json().then(function (err) {
          throw new Error(err.error || 'Secure view failed (' + resp.status + ')');
        });
      }

      var renderer   = resp.headers.get('X-Renderer') || '';
      var totalPages = parseInt(resp.headers.get('X-Asset-Pages') || '0', 10);

      if (totalPages > 0) viewerState.totalPages = totalPages;

      if (renderer) {
        $rendererBdg.textContent = renderer.replace('nodejs-', '');
        $rendererBdg.classList.remove('hidden');
      }

      if (renderer === 'wasm') {
        $watermarkBdg.textContent = 'Watermarked';
        $watermarkBdg.classList.remove('hidden');
      }

      return resp.blob().then(function (blob) {
        return { blob: blob };
      });
    })
    .then(function (result) {
      var blobUrl = URL.createObjectURL(result.blob);

      if (isAudioType) {
        showAudioPlayer(blobUrl);
      } else if (isDocumentType) {
        showDocument(blobUrl);
      } else {
        showImage(blobUrl);
      }

      if (viewerState.totalPages > 1) {
        updatePageCounter();
        loadRemainingPages();
      }
    })
    .catch(function (err) {
      console.error('[dDRM Viewer] Load failed:', err);
      showError('Decryption Failed', err.message || 'Unable to decrypt and render this asset.');
    });
  }

  function loadRemainingPages() {
    for (var i = 2; i <= viewerState.totalPages; i++) {
      (function (pageNum) {
        authFetch('/api/storage/lit/secure-view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(pageNum)),
        })
        .then(function (resp) {
          if (!resp.ok) throw new Error('Page ' + pageNum + ' failed');
          return resp.blob();
        })
        .then(function (blob) {
          var blobUrl = URL.createObjectURL(blob);
          var placeholder = document.getElementById('page-slot-' + pageNum);
          if (placeholder) {
            var img = document.createElement('img');
            img.className = 'page-img';
            img.alt = 'Page ' + pageNum;
            img.draggable = false;
            img.oncontextmenu = function (e) { e.preventDefault(); return false; };
            img.src = blobUrl;
            placeholder.replaceWith(img);
          }
          viewerState.pagesLoaded++;
          updatePageCounter();
        })
        .catch(function (err) {
          console.error('[dDRM Viewer] Page ' + pageNum + ' failed:', err);
          var placeholder = document.getElementById('page-slot-' + pageNum);
          if (placeholder) placeholder.textContent = 'Failed to load page ' + pageNum;
        });
      })(i);
    }
  }

  // ── Display modes ─────────────────────────────────────

  function showLoading() {
    $loading.classList.remove('hidden');
    $error.classList.add('hidden');
    $content.classList.add('hidden');
  }

  function showError(title, message) {
    $loading.classList.add('hidden');
    $error.classList.remove('hidden');
    $content.classList.add('hidden');
    $errorTitle.textContent = title;
    $errorMsg.textContent = message;
  }

  function showImage(url) {
    $loading.classList.add('hidden');
    $error.classList.add('hidden');
    $content.classList.remove('hidden');
    $imgContainer.classList.remove('hidden');
    $docContainer.classList.add('hidden');
    $img.onload = function () {
      imgBaseWidth = $img.clientWidth;
    };
    $img.src = url;
    initToolbar();
  }

  function showDocument(firstPageUrl) {
    $loading.classList.add('hidden');
    $error.classList.add('hidden');
    $content.classList.remove('hidden');
    $imgContainer.classList.add('hidden');
    $docContainer.classList.remove('hidden');
    $docContainer.innerHTML = '';

    var firstImg = document.createElement('img');
    firstImg.className = 'page-img';
    firstImg.alt = 'Page 1';
    firstImg.draggable = false;
    firstImg.oncontextmenu = function (e) { e.preventDefault(); return false; };
    firstImg.src = firstPageUrl;
    $docContainer.appendChild(firstImg);

    viewerState.pagesLoaded = 1;

    for (var i = 2; i <= viewerState.totalPages; i++) {
      var slot = document.createElement('div');
      slot.id = 'page-slot-' + i;
      slot.className = 'page-placeholder';
      slot.textContent = 'Loading page ' + i + '...';
      $docContainer.appendChild(slot);
    }

    if (viewerState.totalPages > 1) {
      $pageNav.style.display = 'flex';
    }

    $content.addEventListener('scroll', trackVisiblePage);
    initToolbar();
  }

  function updatePageCounter() {
    if (viewerState.totalPages <= 1) return;
    var loaded = viewerState.pagesLoaded;
    var total = viewerState.totalPages;
    $pageCounter.textContent = loaded >= total
      ? total + ' pages'
      : loaded + ' / ' + total + ' pages';
    $pageCounter.classList.remove('hidden');
  }

  // ── Anti-piracy measures ──────────────────────────────

  function disableContextMenu() {
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        return;
      }
      if (e.key === 'PrintScreen') { e.preventDefault(); return; }

      switch (e.key) {
        case '+': case '=': e.preventDefault(); zoomIn(); break;
        case '-': case '_': e.preventDefault(); zoomOut(); break;
        case '0': e.preventDefault(); resetZoom(); break;
        case 'f': case 'F':
          if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleFullscreen(); }
          break;
        case 'PageDown':
          if (isDocumentType && viewerState.totalPages > 1) { e.preventDefault(); goToPage(currentPage + 1); }
          break;
        case 'PageUp':
          if (isDocumentType && viewerState.totalPages > 1) { e.preventDefault(); goToPage(currentPage - 1); }
          break;
        case 'Home':
          if (isDocumentType) { e.preventDefault(); $content.scrollTop = 0; }
          break;
        case 'End':
          if (isDocumentType) { e.preventDefault(); $content.scrollTop = $content.scrollHeight; }
          break;
      }
    });
  }

  // ── Utility ───────────────────────────────────────────

  function humanMime(mime) {
    if (!mime) return '';
    var map = {
      'image/jpeg': 'JPEG Image',
      'image/png': 'PNG Image',
      'image/gif': 'GIF Image',
      'image/webp': 'WebP Image',
      'application/pdf': 'PDF Document',
      'text/plain': 'Text Document',
      'text/html': 'HTML Document',
      'audio/mpeg': 'MP3 Audio',
      'video/mp4': 'MP4 Video',
    };
    return map[mime] || mime.split('/').pop().toUpperCase();
  }

  // ── Audio player ────────────────────────────────────

  function showAudioPlayer(blobUrl) {
    $loading.classList.add('hidden');
    $error.classList.add('hidden');
    $content.classList.remove('hidden');
    $imgContainer.classList.add('hidden');
    $docContainer.classList.add('hidden');
    $audioContainer.classList.remove('hidden');

    $audioTitle.textContent = assetParams.title || 'Audio';
    $audioEl.src = blobUrl;
    $audioEl.volume = 0.8;

    $btnAudioPlay.addEventListener('click', function () {
      if ($audioEl.paused) { $audioEl.play(); } else { $audioEl.pause(); }
    });

    $audioEl.addEventListener('play', function () {
      $audioPlayIcon.style.display = 'none';
      $audioPauseIcon.style.display = '';
    });

    $audioEl.addEventListener('pause', function () {
      $audioPlayIcon.style.display = '';
      $audioPauseIcon.style.display = 'none';
    });

    $audioEl.addEventListener('timeupdate', function () {
      if (!$audioEl.duration) return;
      var pct = ($audioEl.currentTime / $audioEl.duration) * 100;
      $audioSeek.value = pct;
      $audioTime.textContent = fmtTime($audioEl.currentTime) + ' / ' + fmtTime($audioEl.duration);
    });

    $audioSeek.addEventListener('input', function () {
      if (!$audioEl.duration) return;
      $audioEl.currentTime = ($audioSeek.value / 100) * $audioEl.duration;
    });

    $audioVolume.addEventListener('input', function () {
      $audioEl.volume = $audioVolume.value / 100;
    });
  }

  function fmtTime(s) {
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // ── Zoom & Pan ────────────────────────────────────────

  function zoomIn() { setZoom(Math.min(zoom.level + zoom.step, zoom.max)); }
  function zoomOut() { setZoom(Math.max(zoom.level - zoom.step, zoom.min)); }
  function resetZoom() { setZoom(1); }

  function setZoom(level) {
    level = Math.round(level * 100) / 100;
    if (level === zoom.level) return;

    var oldLevel = zoom.level;
    zoom.level = level;

    var cx = $content.scrollLeft + $content.clientWidth / 2;
    var cy = $content.scrollTop + $content.clientHeight / 2;

    applyZoom();

    if (oldLevel !== 1 || level !== 1) {
      var ratio = (oldLevel === 1) ? level : level / oldLevel;
      if (oldLevel !== 1) {
        $content.scrollLeft = cx * ratio - $content.clientWidth / 2;
        $content.scrollTop = cy * ratio - $content.clientHeight / 2;
      }
    }

    showToolbarBriefly();
  }

  function applyZoom() {
    $zoomLevel.textContent = Math.round(zoom.level * 100) + '%';
    $btnZoomOut.disabled = zoom.level <= zoom.min;
    $btnZoomIn.disabled = zoom.level >= zoom.max;

    if (isDocumentType) {
      $docContainer.style.width = (100 * zoom.level) + '%';
    } else {
      if (zoom.level === 1) {
        $imgContainer.classList.remove('zoomed');
        $img.style.width = '';
      } else {
        $imgContainer.classList.add('zoomed');
        var base = imgBaseWidth || $img.naturalWidth || $content.clientWidth;
        $img.style.width = (base * zoom.level) + 'px';
      }
    }

    $content.classList.toggle('zoomable', zoom.level > 1 || isDocumentType);
  }

  // Drag-to-scroll (pan)
  function initPanHandlers() {
    $content.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (zoom.level <= 1 && !isDocumentType) return;
      pan.active = true;
      pan.startX = e.clientX;
      pan.startY = e.clientY;
      pan.scrollX = $content.scrollLeft;
      pan.scrollY = $content.scrollTop;
      $content.classList.add('panning');
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!pan.active) return;
      $content.scrollLeft = pan.scrollX - (e.clientX - pan.startX);
      $content.scrollTop = pan.scrollY - (e.clientY - pan.startY);
    });

    document.addEventListener('mouseup', function () {
      if (!pan.active) return;
      pan.active = false;
      $content.classList.remove('panning');
    });

    $content.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn(); else zoomOut();
    }, { passive: false });
  }

  // ── Page navigation (documents) ─────────────────────

  function trackVisiblePage() {
    if (!isDocumentType || viewerState.totalPages <= 1) return;
    var pages = $docContainer.querySelectorAll('.page-img');
    if (!pages.length) return;
    var scrollMid = $content.scrollTop + $content.clientHeight / 2;
    var found = 1;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].offsetTop <= scrollMid) found = i + 1;
    }
    if (found !== currentPage) {
      currentPage = found;
      updatePageIndicator();
    }
  }

  function goToPage(n) {
    if (n < 1 || n > viewerState.totalPages) return;
    var pages = $docContainer.querySelectorAll('.page-img, .page-placeholder');
    if (pages[n - 1]) {
      pages[n - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    currentPage = n;
    updatePageIndicator();
  }

  function updatePageIndicator() {
    if ($pageIndicator) {
      $pageIndicator.textContent = currentPage + ' / ' + viewerState.totalPages;
    }
    if ($btnPagePrev) $btnPagePrev.disabled = currentPage <= 1;
    if ($btnPageNext) $btnPageNext.disabled = currentPage >= viewerState.totalPages;
  }

  // ── Toolbar ─────────────────────────────────────────

  function initToolbar() {
    $toolbar.classList.remove('hidden');

    $btnZoomIn.addEventListener('click', zoomIn);
    $btnZoomOut.addEventListener('click', zoomOut);
    $zoomLevel.addEventListener('click', resetZoom);
    $btnFullscreen.addEventListener('click', toggleFullscreen);

    if ($btnPagePrev) $btnPagePrev.addEventListener('click', function () { goToPage(currentPage - 1); });
    if ($btnPageNext) $btnPageNext.addEventListener('click', function () { goToPage(currentPage + 1); });

    initPanHandlers();

    $content.addEventListener('mousemove', showToolbarBriefly);
    $toolbar.addEventListener('mouseenter', function () { clearTimeout(toolbarTimer); });
    $toolbar.addEventListener('mouseleave', function () { scheduleToolbarHide(); });

    applyZoom();
    showToolbarBriefly();
  }

  function showToolbarBriefly() {
    $toolbar.classList.remove('toolbar-fade');
    scheduleToolbarHide();
  }

  function scheduleToolbarHide() {
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(function () {
      if (!$toolbar.matches(':hover')) {
        $toolbar.classList.add('toolbar-fade');
      }
    }, 3000);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  }

  // ── Go ────────────────────────────────────────────────

  init();
})();
