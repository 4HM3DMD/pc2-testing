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

  // ── State ─────────────────────────────────────────────

  var viewerState = {
    totalPages: 1,
    pagesLoaded: 0,
  };

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

      if (isDocumentType) {
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
    $img.src = url;
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
      }
      if (e.key === 'PrintScreen') e.preventDefault();
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

  // ── Go ────────────────────────────────────────────────

  init();
})();
