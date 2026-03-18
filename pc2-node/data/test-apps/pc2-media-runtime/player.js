'use strict';

// ─── Parameters ──────────────────────────────────────────────────────
let params = {};
try {
  const raw = new URLSearchParams(window.location.search).get('puter.args');
  if (raw) params = JSON.parse(raw);
} catch { /* ignore */ }
const CHANNEL = params.channel || new URLSearchParams(window.location.search).get('channel');
const TOKEN_ID = params.tokenId || new URLSearchParams(window.location.search).get('tokenId');
const MEDIA_URI = params.mediaUri || new URLSearchParams(window.location.search).get('mediaUri') || '';
const TOKEN_URI = params.tokenURI || new URLSearchParams(window.location.search).get('tokenURI') || '';
const TITLE = params.title || new URLSearchParams(window.location.search).get('title') || '';
const AUTHORITY = params.authority || new URLSearchParams(window.location.search).get('authority') || '';
let BUYER_ADDRESS = params.buyerAddress || '';
let REQUEST_ID = params.requestId || '';
let LIT_AUTH_SIG = params.litAuthSig || null;
const STANDALONE = params.standalone === 'true' || params.standalone === true;

// ─── DOM ─────────────────────────────────────────────────────────────
const $loading = document.getElementById('loading-screen');
const $loadingText = document.getElementById('loading-text');
const $error = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');
const $container = document.getElementById('player-container');
const $video = document.getElementById('video');
const $videoWrapper = document.getElementById('video-wrapper');
const $watermark = document.getElementById('watermark');
const $bufferingOverlay = document.getElementById('buffering-overlay');
const $btnPlay = document.getElementById('btn-play');
const $iconPlay = document.getElementById('icon-play');
const $iconPause = document.getElementById('icon-pause');
const $seekBar = document.getElementById('seek-bar');
const $seekProgress = document.getElementById('seek-bar-progress');
const $seekBuffered = document.getElementById('seek-bar-buffered');
const $timeCurrent = document.getElementById('time-current');
const $timeDuration = document.getElementById('time-duration');
const $volumeBar = document.getElementById('volume-bar');
const $btnMute = document.getElementById('btn-mute');
const $iconVolOn = document.getElementById('icon-vol-on');
const $iconVolOff = document.getElementById('icon-vol-off');
const $btnFullscreen = document.getElementById('btn-fullscreen');
const $controls = document.getElementById('controls');

// ─── Auth ────────────────────────────────────────────────────────────
function getAuthToken() {
  const sp = new URLSearchParams(window.location.search);
  return sp.get('puter.auth.token') || window.auth_token || localStorage.getItem('auth_token') || '';
}

function apiOrigin() {
  const sp = new URLSearchParams(window.location.search);
  return sp.get('puter.api_origin') || window.location.origin;
}

async function apiFetch(path, body) {
  const res = await fetch(apiOrigin() + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getAuthToken(),
    },
    body: JSON.stringify(body),
  });
  return res;
}

// ─── State ───────────────────────────────────────────────────────────
let sessionId = null;
let tracks = [];
let videoTrackIdx = -1;
let audioTrackIdx = -1;
let mediaSource = null;
let videoSB = null;
let audioSB = null;
let videoSegmentQueue = [];
let audioSegmentQueue = [];
let videoNextSeg = 0;
let audioNextSeg = 0;
let videoSegCount = 0;
let audioSegCount = 0;
let isAppendingVideo = false;
let isAppendingAudio = false;
let duration = 0;
let bufferLoopId = null;
let controlsIdleTimer = null;
let isSeeking = false;
let isAudioOnly = false;

// Segment start times (seconds) per track, from server
let videoSegStarts = [];
let audioSegStarts = [];

// ABR state
let allVideoTracks = [];       // sorted low→high bandwidth
let currentQualityIdx = -1;    // index into allVideoTracks
let abrMode = 'auto';          // 'auto' or track index number for manual
let bandwidthSamples = [];     // recent throughput measurements (bps)
let lastSwitchTime = 0;        // prevent rapid switching
let isSwitchingQuality = false;
const ABR_SAMPLE_WINDOW = 6;   // keep last N samples
const ABR_SWITCH_COOLDOWN_MS = 8000;
const ABR_UPGRADE_FACTOR = 1.3;  // need 30% headroom to upgrade
const ABR_DOWNGRADE_FACTOR = 0.9;

const BUFFER_AHEAD_SEC = 20;
const BUFFER_EVICT_BEHIND_SEC = 30;
const MAX_SEGMENT_RETRIES = 3;
const MAX_SESSION_REFRESHES = 2;

// Session refresh state — ensures only one refresh runs at a time
let sessionRefreshPromise = null;
let sessionRefreshCount = 0;

// ─── Helpers ─────────────────────────────────────────────────────────
function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

function showError(msg) {
  $loading.style.display = 'none';
  $container.style.display = 'none';
  $error.style.display = 'flex';
  $errorText.textContent = msg;
}

// ─── Session Refresh ─────────────────────────────────────────────────
async function refreshSession() {
  if (sessionRefreshCount >= MAX_SESSION_REFRESHES) {
    throw new Error('Session refresh limit reached. Please reload the player.');
  }

  // Coalesce concurrent refresh requests into one
  if (sessionRefreshPromise) return sessionRefreshPromise;

  sessionRefreshPromise = (async () => {
    try {
      console.log('[player] Session expired — refreshing...');
      sessionRefreshCount++;

      // Re-authenticate via wallet (works for both standalone and market-launched)
      if (window.ethereum) {
  const accounts = await window.ethereum.request({ method: 'eth_accounts' })
        .then(a => (a && a.length > 0) ? a : window.ethereum.request({ method: 'eth_requestAccounts' }));
        const eoaAddress = accounts[0];
        const sp = new URLSearchParams(window.location.search);
        BUYER_ADDRESS = sp.get('puter.smart_account') || eoaAddress;

        const prepareRes = await apiFetch('/api/media/prepare-auth', { buyerAddress: eoaAddress });
        if (!prepareRes.ok) {
          const err = await prepareRes.json().catch(() => ({ error: prepareRes.statusText }));
          throw new Error(err.error || 'Failed to prepare re-authentication');
        }
        const { requestId, siweMessage } = await prepareRes.json();
        REQUEST_ID = requestId;

        const msgHex = '0x' + Array.from(new TextEncoder().encode(siweMessage))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        const sig = await window.ethereum.request({
          method: 'personal_sign',
          params: [msgHex, eoaAddress],
        });

        LIT_AUTH_SIG = {
          sig,
          derivedVia: 'web3.eth.personal.sign',
          signedMessage: siweMessage,
          address: eoaAddress,
        };
      }

      // Re-init the session to get a new sessionId with fresh CEK
      const initBody = {
        channel: CHANNEL,
        tokenId: TOKEN_ID,
        mediaUri: MEDIA_URI,
        tokenURI: TOKEN_URI,
        title: TITLE,
        authority: AUTHORITY,
        buyerAddress: BUYER_ADDRESS,
      };
      if (REQUEST_ID) initBody.requestId = REQUEST_ID;
      if (LIT_AUTH_SIG) initBody.litAuthSig = LIT_AUTH_SIG;

      const initRes = await apiFetch('/api/media/init', initBody);
      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({ error: initRes.statusText }));
        throw new Error(err.error || 'Failed to re-initialize session');
      }

      const data = await initRes.json();
      sessionId = data.sessionId;

      // Re-send init segments so the server caches them for WASM tenc extraction
      if (videoTrackIdx !== -1) {
        await apiFetch('/api/media/segment', { sessionId, trackIndex: videoTrackIdx, init: true });
      }
      if (audioTrackIdx !== -1) {
        await apiFetch('/api/media/segment', { sessionId, trackIndex: audioTrackIdx, init: true });
      }

      console.log('[player] Session refreshed: ' + sessionId);
    } finally {
      sessionRefreshPromise = null;
    }
  })();

  return sessionRefreshPromise;
}

// ─── MSE Engine ──────────────────────────────────────────────────────
async function fetchSegmentWithRetry(trackIndex, segmentNumber, init) {
  const body = { sessionId, trackIndex };
  if (init) body.init = true;
  else body.segmentNumber = segmentNumber;

  for (let attempt = 0; attempt < MAX_SEGMENT_RETRIES; attempt++) {
    try {
      const t0 = performance.now();
      const res = await apiFetch('/api/media/segment', body);

      if (res.status === 410) {
        await refreshSession();
        body.sessionId = sessionId;
        const retryRes = await apiFetch('/api/media/segment', body);
        if (!retryRes.ok) {
          const err = await retryRes.json().catch(() => ({ error: retryRes.statusText }));
          throw new Error(err.error || 'Failed to fetch segment after session refresh');
        }
        return await retryRes.arrayBuffer();
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Failed to fetch segment');
      }

      const buf = await res.arrayBuffer();

      // Measure throughput for ABR (only for non-init video segments)
      if (!init && trackIndex === videoTrackIdx && buf.byteLength > 1000) {
        const elapsedSec = (performance.now() - t0) / 1000;
        if (elapsedSec > 0.05) {
          const bps = (buf.byteLength * 8) / elapsedSec;
          bandwidthSamples.push(bps);
          if (bandwidthSamples.length > ABR_SAMPLE_WINDOW) bandwidthSamples.shift();
        }
      }

      return buf;
    } catch (e) {
      if (attempt === MAX_SEGMENT_RETRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

function appendToSourceBuffer(sb, data, queue, setAppending) {
  return new Promise((resolve, reject) => {
    const label = (sb === videoSB) ? 'video' : 'audio';
    console.log('[player] appendToSourceBuffer(' + label + '): ' + data.byteLength + 'B, updating=' + sb.updating);
    if (sb.updating) {
      console.log('[player] SB(' + label + ') busy, queuing');
      queue.push({ data, resolve, reject });
      return;
    }
    setAppending(true);
    const onUpdate = () => {
      sb.removeEventListener('updateend', onUpdate);
      sb.removeEventListener('error', onError);
      setAppending(false);
      console.log('[player] SB(' + label + ') append OK, buffered ranges:', sb.buffered.length);
      processQueue(sb, queue, setAppending);
      resolve();
    };
    const onError = (e) => {
      sb.removeEventListener('updateend', onUpdate);
      sb.removeEventListener('error', onError);
      setAppending(false);
      console.error('[player] SB(' + label + ') append error:', e);
      reject(e);
    };
    try {
      sb.addEventListener('updateend', onUpdate);
      sb.addEventListener('error', onError);
      sb.appendBuffer(data);
    } catch (syncErr) {
      sb.removeEventListener('updateend', onUpdate);
      sb.removeEventListener('error', onError);
      setAppending(false);
      console.error('[player] SB(' + label + ') appendBuffer threw:', syncErr.name, syncErr.message);
      reject(syncErr);
    }
  });
}

function processQueue(sb, queue, setAppending) {
  if (queue.length === 0 || sb.updating) return;
  const { data, resolve, reject } = queue.shift();
  setAppending(true);
  const onUpdate = () => {
    sb.removeEventListener('updateend', onUpdate);
    sb.removeEventListener('error', onError);
    setAppending(false);
    processQueue(sb, queue, setAppending);
    resolve();
  };
  const onError = (e) => {
    sb.removeEventListener('updateend', onUpdate);
    sb.removeEventListener('error', onError);
    setAppending(false);
    reject(e);
  };
  sb.addEventListener('updateend', onUpdate);
  sb.addEventListener('error', onError);
  sb.appendBuffer(data);
}

function getBufferedEnd(sb) {
  if (!sb || sb.buffered.length === 0) return 0;
  let maxEnd = 0;
  for (let i = 0; i < sb.buffered.length; i++) {
    if (sb.buffered.end(i) > maxEnd) maxEnd = sb.buffered.end(i);
  }
  return maxEnd;
}

function evictOldBuffers(sb, currentTime) {
  if (!sb || sb.updating || sb.buffered.length === 0) return;
  const evictEnd = currentTime - BUFFER_EVICT_BEHIND_SEC;
  if (evictEnd <= 0) return;
  for (let i = 0; i < sb.buffered.length; i++) {
    if (sb.buffered.end(i) < evictEnd) {
      try { sb.remove(sb.buffered.start(i), sb.buffered.end(i)); } catch { /* skip */ }
      return;
    }
  }
}

// ─── Seek Recovery ───────────────────────────────────────────────────
function segmentIndexForTime(time, segStarts) {
  if (!segStarts.length) return 0;
  for (let i = segStarts.length - 1; i >= 0; i--) {
    if (segStarts[i] <= time) return i;
  }
  return 0;
}

function isTimeBuffered(time) {
  const buf = $video.buffered;
  for (let i = 0; i < buf.length; i++) {
    if (time >= buf.start(i) && time <= buf.end(i)) return true;
  }
  return false;
}

async function handleSeekToUnbuffered(targetTime) {
  if (isSeeking) return;
  isSeeking = true;
  $bufferingOverlay.style.display = 'flex';

  try {
    const newVideoSeg = videoTrackIdx !== -1 ? segmentIndexForTime(targetTime, videoSegStarts) : 0;
    const newAudioSeg = audioTrackIdx !== -1 ? segmentIndexForTime(targetTime, audioSegStarts) : 0;

    // Flush existing buffers
    if (videoSB && !videoSB.updating) {
      try { videoSB.remove(0, Infinity); } catch { /* ignore */ }
      await new Promise(r => { videoSB.addEventListener('updateend', r, { once: true }); });
    }
    if (audioSB && !audioSB.updating) {
      try { audioSB.remove(0, Infinity); } catch { /* ignore */ }
      await new Promise(r => { audioSB.addEventListener('updateend', r, { once: true }); });
    }

    // Re-append init segments (required after flush)
    if (videoSB) {
      const initData = await fetchSegmentWithRetry(videoTrackIdx, 0, true);
      await appendToSourceBuffer(videoSB, initData, videoSegmentQueue, v => isAppendingVideo = v);
    }
    if (audioSB) {
      const initData = await fetchSegmentWithRetry(audioTrackIdx, 0, true);
      await appendToSourceBuffer(audioSB, initData, audioSegmentQueue, v => isAppendingAudio = v);
    }

    // Fetch a batch from the new position
    videoNextSeg = newVideoSeg;
    audioNextSeg = newAudioSeg;
    const batch = 3;

    if (videoSB) {
      for (let i = 0; i < batch && videoNextSeg < videoSegCount; i++) {
        const data = await fetchSegmentWithRetry(videoTrackIdx, videoNextSeg, false);
        await appendToSourceBuffer(videoSB, data, videoSegmentQueue, v => isAppendingVideo = v);
        videoNextSeg++;
      }
    }
    if (audioSB) {
      for (let i = 0; i < batch && audioNextSeg < audioSegCount; i++) {
        const data = await fetchSegmentWithRetry(audioTrackIdx, audioNextSeg, false);
        await appendToSourceBuffer(audioSB, data, audioSegmentQueue, v => isAppendingAudio = v);
        audioNextSeg++;
      }
    }

    $video.currentTime = targetTime;
  } catch (e) {
    console.error('[player] Seek recovery failed:', e);
  } finally {
    isSeeking = false;
    $bufferingOverlay.style.display = 'none';
  }
}

// ─── Standalone Lit Auth (for filesystem double-click launch) ────────
async function performStandaloneLitAuth() {
  if (!window.ethereum) {
    throw new Error('Wallet not available. Please ensure your wallet is connected.');
  }

  $loadingText.textContent = 'Connecting wallet...';

  const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    .then(a => (a && a.length > 0) ? a : window.ethereum.request({ method: 'eth_requestAccounts' }));
  const eoaAddress = accounts[0];
  const sp = new URLSearchParams(window.location.search);
  BUYER_ADDRESS = sp.get('puter.smart_account') || eoaAddress;

  $loadingText.textContent = 'Preparing Lit authentication...';

  const prepareRes = await apiFetch('/api/media/prepare-auth', { buyerAddress: eoaAddress });
  if (!prepareRes.ok) {
    const err = await prepareRes.json().catch(() => ({ error: prepareRes.statusText }));
    throw new Error(err.error || 'Failed to prepare Lit authentication');
  }
  const { requestId, siweMessage } = await prepareRes.json();
  REQUEST_ID = requestId;

  $loadingText.textContent = 'Please sign the authentication message in your wallet...';

  const msgHex = '0x' + Array.from(new TextEncoder().encode(siweMessage))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const sig = await window.ethereum.request({
    method: 'personal_sign',
    params: [msgHex, eoaAddress],
  });

  LIT_AUTH_SIG = {
    sig: sig,
    derivedVia: 'web3.eth.personal.sign',
    signedMessage: siweMessage,
    address: eoaAddress,
  };
}

// ─── Init ────────────────────────────────────────────────────────────
async function init() {
  if (!CHANNEL || !TOKEN_ID) {
    showError('Missing channel or tokenId parameters.');
    return;
  }

  try {
    if (STANDALONE && !LIT_AUTH_SIG) {
      await performStandaloneLitAuth();
    }

    $loadingText.textContent = 'Resolving content and recovering decryption key...';

    const initBody = {
      channel: CHANNEL,
      tokenId: TOKEN_ID,
      mediaUri: MEDIA_URI,
      tokenURI: TOKEN_URI,
      title: TITLE,
      authority: AUTHORITY,
      buyerAddress: BUYER_ADDRESS,
    };
    if (REQUEST_ID) initBody.requestId = REQUEST_ID;
    if (LIT_AUTH_SIG) initBody.litAuthSig = LIT_AUTH_SIG;
    const initRes = await apiFetch('/api/media/init', initBody);
    if (!initRes.ok) {
      const err = await initRes.json().catch(() => ({ error: initRes.statusText }));
      showError(err.error || 'Failed to initialize playback');
      return;
    }

    const data = await initRes.json();
    sessionId = data.sessionId;
    duration = data.duration;
    tracks = data.tracks;

    if (data.title) {
      document.title = data.title + ' — PC2 Media Player';
    }

    allVideoTracks = tracks.filter(t => t.type === 'video').sort((a, b) => a.bandwidth - b.bandwidth);
    const audioTracks = tracks.filter(t => t.type === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);

    if (allVideoTracks.length > 0) {
      // Start at lowest quality for fast initial buffer, ABR will ramp up
      currentQualityIdx = 0;
      const chosen = allVideoTracks[currentQualityIdx];
      videoTrackIdx = chosen.index;
      videoSegCount = chosen.segmentCount;
      videoSegStarts = chosen.segmentStarts || [];
    }
    if (audioTracks.length > 0) {
      audioTrackIdx = audioTracks[0].index;
      audioSegCount = audioTracks[0].segmentCount;
      audioSegStarts = audioTracks[0].segmentStarts || [];
    }

    if (videoTrackIdx === -1 && audioTrackIdx === -1) {
      showError('No playable tracks found in content.');
      return;
    }

    // Audio-only: show music placeholder
    isAudioOnly = videoTrackIdx === -1;
    if (isAudioOnly) {
      const $audioArt = document.getElementById('audio-art');
      const $audioTitle = document.getElementById('audio-title');
      if ($audioArt) $audioArt.style.display = 'flex';
      if ($audioTitle) $audioTitle.textContent = data.title || 'Audio';
    }

    const sp = new URLSearchParams(window.location.search);
    const addr = sp.get('puter.smart_account') || params.buyerAddress || '';
    if (addr) {
      $watermark.textContent = addr.substring(0, 10) + '...' + addr.substring(addr.length - 6) + '\n' + new Date().toISOString().split('T')[0];
    }

    $loadingText.textContent = 'Buffering media segments...';

    if (!window.MediaSource) {
      showError('MediaSource API not available in this browser.');
      return;
    }

    mediaSource = new MediaSource();
    const msUrl = URL.createObjectURL(mediaSource);
    console.log('[player] MediaSource state:', mediaSource.readyState, 'URL:', msUrl);
    $video.src = msUrl;

    mediaSource.addEventListener('sourceended', () => {
      console.log('[player] sourceended fired, readyState:', mediaSource.readyState);
    });
    mediaSource.addEventListener('sourceclose', () => {
      console.warn('[player] sourceclose fired — MediaSource was detached from video element');
    });

    $video.addEventListener('error', () => {
      const e = $video.error;
      console.error('[player] <video> error event: code=' + (e && e.code) + ' message=' + (e && e.message));
    });

    mediaSource.addEventListener('sourceopen', async () => {
      console.log('[player] sourceopen fired, readyState:', mediaSource.readyState);
      URL.revokeObjectURL(msUrl);
      try {
        if (videoTrackIdx !== -1) {
          const vTrack = tracks[videoTrackIdx];
          const vCodec = `${vTrack.mimeType}; codecs="${vTrack.codec}"`;
          console.log('[player] Video codec:', vCodec, 'isTypeSupported:', MediaSource.isTypeSupported(vCodec));
          if (!MediaSource.isTypeSupported(vCodec)) {
            showError(`Video codec "${vTrack.codec}" is not supported by this browser. Please update your browser or contact the creator.`);
            return;
          }
          videoSB = mediaSource.addSourceBuffer(vCodec);
          console.log('[player] Video SourceBuffer created');
        }
        if (audioTrackIdx !== -1) {
          const aTrack = tracks[audioTrackIdx];
          const aCodec = `${aTrack.mimeType}; codecs="${aTrack.codec}"`;
          console.log('[player] Audio codec:', aCodec, 'isTypeSupported:', MediaSource.isTypeSupported(aCodec));
          if (!MediaSource.isTypeSupported(aCodec)) {
            showError(`Audio codec "${aTrack.codec}" is not supported by this browser.`);
            return;
          }
          audioSB = mediaSource.addSourceBuffer(aCodec);
          console.log('[player] Audio SourceBuffer created');
        }

        if (videoSB) {
          const initData = await fetchSegmentWithRetry(videoTrackIdx, 0, true);
          console.log('[player] Video init data received:', initData.byteLength, 'bytes');
          console.log('[player] Video init first 16 bytes:', Array.from(new Uint8Array(initData.slice(0, 16))).map(b => b.toString(16).padStart(2, '0')).join(' '));
          console.log('[player] Video SB readyState before append:', mediaSource.readyState, 'videoSB.updating:', videoSB.updating);
          await appendToSourceBuffer(videoSB, initData, videoSegmentQueue, v => isAppendingVideo = v);
          console.log('[player] Video init appended OK');
        }
        if (audioSB) {
          const initData = await fetchSegmentWithRetry(audioTrackIdx, 0, true);
          console.log('[player] Audio init data received:', initData.byteLength, 'bytes');
          console.log('[player] Audio SB readyState before append:', mediaSource.readyState, 'audioSB.updating:', audioSB.updating);
          await appendToSourceBuffer(audioSB, initData, audioSegmentQueue, v => isAppendingAudio = v);
          console.log('[player] Audio init appended OK');
        }

        videoNextSeg = 0;
        audioNextSeg = 0;

        const initialBatch = 4;
        if (videoSB) {
          for (let i = 0; i < initialBatch && videoNextSeg < videoSegCount; i++) {
            const data = await fetchSegmentWithRetry(videoTrackIdx, videoNextSeg, false);
            await appendToSourceBuffer(videoSB, data, videoSegmentQueue, v => isAppendingVideo = v);
            videoNextSeg++;
          }
        }
        if (audioSB) {
          for (let i = 0; i < initialBatch && audioNextSeg < audioSegCount; i++) {
            const data = await fetchSegmentWithRetry(audioTrackIdx, audioNextSeg, false);
            await appendToSourceBuffer(audioSB, data, audioSegmentQueue, v => isAppendingAudio = v);
            audioNextSeg++;
          }
        }

        $loading.style.display = 'none';
        $container.style.display = 'flex';
        $timeDuration.textContent = formatTime(duration);
        $seekBar.max = String(duration);

        startBufferLoop();
        buildQualityMenu();

        $video.play().catch(() => {});

      } catch (e) {
        const msg = e.message || e.type || (typeof e === 'string' ? e : JSON.stringify(e));
        showError('Failed to buffer media: ' + msg);
      }
    });

  } catch (e) {
    showError('Initialization failed: ' + e.message);
  }
}

// ─── ABR Engine ──────────────────────────────────────────────────────
function getEstimatedBandwidth() {
  if (bandwidthSamples.length < 2) return 0;
  // Use harmonic mean (conservative, better for variable networks)
  let sumInverse = 0;
  for (const s of bandwidthSamples) sumInverse += 1 / s;
  return bandwidthSamples.length / sumInverse;
}

function selectQuality(estimatedBps) {
  if (abrMode !== 'auto' || allVideoTracks.length <= 1) return currentQualityIdx;

  // Find highest quality whose bandwidth fits within estimated throughput
  let bestIdx = 0;
  for (let i = allVideoTracks.length - 1; i >= 0; i--) {
    if (allVideoTracks[i].bandwidth * ABR_UPGRADE_FACTOR <= estimatedBps) {
      bestIdx = i;
      break;
    }
  }

  // Downgrade quickly: if current quality exceeds bandwidth, step down
  if (currentQualityIdx > 0 && allVideoTracks[currentQualityIdx].bandwidth > estimatedBps * ABR_DOWNGRADE_FACTOR) {
    return Math.max(0, currentQualityIdx - 1);
  }

  // Upgrade conservatively: only go up one step at a time
  if (bestIdx > currentQualityIdx) return currentQualityIdx + 1;

  return currentQualityIdx;
}

async function switchVideoQuality(newQualityIdx) {
  if (isSwitchingQuality || newQualityIdx === currentQualityIdx) return;
  if (!videoSB || isAppendingVideo) return;
  isSwitchingQuality = true;

  try {
    const newTrack = allVideoTracks[newQualityIdx];
    const oldLabel = formatQualityLabel(allVideoTracks[currentQualityIdx]);
    const newLabel = formatQualityLabel(newTrack);
    console.log(`[ABR] Switching: ${oldLabel} → ${newLabel} (${Math.round(getEstimatedBandwidth() / 1000)}kbps measured)`);

    currentQualityIdx = newQualityIdx;
    videoTrackIdx = newTrack.index;
    videoSegCount = newTrack.segmentCount;
    videoSegStarts = newTrack.segmentStarts || [];
    lastSwitchTime = Date.now();

    // Map current playback position to segment number in new track
    const ct = $video.currentTime;
    const bufEnd = getBufferedEnd(videoSB);
    videoNextSeg = segmentIndexForTime(bufEnd > ct ? bufEnd : ct, videoSegStarts);

    // Append the new track's init segment (tells MSE about the new codec params)
    const initData = await fetchSegmentWithRetry(videoTrackIdx, 0, true);
    await appendToSourceBuffer(videoSB, initData, videoSegmentQueue, v => isAppendingVideo = v);
  } catch (e) {
    console.error('[ABR] Quality switch failed:', e);
  } finally {
    isSwitchingQuality = false;
  }
}

function formatQualityLabel(track) {
  const w = track.width || 0;
  const h = track.height || 0;
  // Use the shorter dimension as the conventional "p" label (handles portrait too)
  const p = (w && h) ? Math.min(w, h) : (h || w);
  if (p) return p + 'p';
  return Math.round(track.bandwidth / 1000) + 'kbps';
}

// ─── Buffer Loop ─────────────────────────────────────────────────────
function startBufferLoop() {
  bufferLoopId = setInterval(async () => {
    if (isSeeking || isSwitchingQuality) return;
    const ct = $video.currentTime;
    let videoAllDone = videoTrackIdx === -1;
    let audioAllDone = audioTrackIdx === -1;

    evictOldBuffers(videoSB, ct);
    evictOldBuffers(audioSB, ct);

    // ABR: check if we should switch quality
    if (videoSB && allVideoTracks.length > 1 && abrMode === 'auto' && !isSwitchingQuality) {
      const bw = getEstimatedBandwidth();
      if (bw > 0 && Date.now() - lastSwitchTime > ABR_SWITCH_COOLDOWN_MS) {
        const newIdx = selectQuality(bw);
        if (newIdx !== currentQualityIdx) {
          await switchVideoQuality(newIdx);
        }
      }
    }

    if (videoSB && videoNextSeg < videoSegCount && !isAppendingVideo && !isSwitchingQuality) {
      const bufEnd = getBufferedEnd(videoSB);
      if (bufEnd - ct < BUFFER_AHEAD_SEC) {
        try {
          const data = await fetchSegmentWithRetry(videoTrackIdx, videoNextSeg, false);
          await appendToSourceBuffer(videoSB, data, videoSegmentQueue, v => isAppendingVideo = v);
          videoNextSeg++;
        } catch { /* retry next tick */ }
      }
    }
    if (videoNextSeg >= videoSegCount) videoAllDone = true;

    if (audioSB && audioNextSeg < audioSegCount && !isAppendingAudio) {
      const bufEnd = getBufferedEnd(audioSB);
      if (bufEnd - ct < BUFFER_AHEAD_SEC) {
        try {
          const data = await fetchSegmentWithRetry(audioTrackIdx, audioNextSeg, false);
          await appendToSourceBuffer(audioSB, data, audioSegmentQueue, v => isAppendingAudio = v);
          audioNextSeg++;
        } catch { /* retry next tick */ }
      }
    }
    if (audioNextSeg >= audioSegCount) audioAllDone = true;

    if (videoAllDone && audioAllDone && mediaSource.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch { /* already ended */ }
    }
  }, 1000);
}

// ─── Controls ────────────────────────────────────────────────────────
function togglePlay() {
  if ($video.paused) $video.play();
  else $video.pause();
}

$btnPlay.addEventListener('click', togglePlay);
$videoWrapper.addEventListener('click', (e) => {
  if (e.target === $video || e.target === $videoWrapper) togglePlay();
});

$video.addEventListener('play', () => { $iconPlay.style.display = 'none'; $iconPause.style.display = 'block'; });
$video.addEventListener('pause', () => { $iconPlay.style.display = 'block'; $iconPause.style.display = 'none'; });

$video.addEventListener('timeupdate', () => {
  $timeCurrent.textContent = formatTime($video.currentTime);
  if (duration > 0) {
    $seekBar.value = String($video.currentTime);
    $seekProgress.style.width = ($video.currentTime / duration * 100) + '%';
  }
  updateBufferedBar();
});

$seekBar.addEventListener('input', () => {
  const targetTime = parseFloat($seekBar.value);
  if (isTimeBuffered(targetTime)) {
    $video.currentTime = targetTime;
  } else {
    handleSeekToUnbuffered(targetTime);
  }
});

function updateBufferedBar() {
  if (!$video.buffered.length) return;
  let maxEnd = 0;
  for (let i = 0; i < $video.buffered.length; i++) {
    if ($video.buffered.end(i) > maxEnd) maxEnd = $video.buffered.end(i);
  }
  $seekBuffered.style.width = (maxEnd / duration * 100) + '%';
}

$volumeBar.addEventListener('input', () => { $video.volume = parseInt($volumeBar.value) / 100; });

function updateMuteIcon() {
  const muted = $video.muted || $video.volume === 0;
  $iconVolOn.style.display = muted ? 'none' : 'block';
  $iconVolOff.style.display = muted ? 'block' : 'none';
}

$btnMute.addEventListener('click', () => {
  $video.muted = !$video.muted;
  $volumeBar.value = $video.muted ? '0' : String(Math.round($video.volume * 100));
  updateMuteIcon();
});
$video.volume = 0.8;

$btnFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.getElementById('player-root').requestFullscreen();
});

// ─── Quality Selector ────────────────────────────────────────────────
const $btnQuality = document.getElementById('btn-quality');
const $qualityMenu = document.getElementById('quality-menu');
const $qualityGroup = document.getElementById('quality-group');

function buildQualityMenu() {
  if (!$qualityMenu || allVideoTracks.length === 0) {
    if ($qualityGroup) $qualityGroup.style.display = 'none';
    return;
  }

  $qualityMenu.innerHTML = '';

  const currentLabel = (currentQualityIdx >= 0) ? formatQualityLabel(allVideoTracks[currentQualityIdx]) : '';

  // Auto option
  const autoItem = document.createElement('div');
  autoItem.className = 'q-item' + (abrMode === 'auto' ? ' active' : '');
  const autoSuffix = abrMode === 'auto' && currentLabel ? ' (' + currentLabel + ')' : '';
  autoItem.innerHTML = '<span class="q-dot"></span>Auto' + autoSuffix;
  autoItem.addEventListener('click', () => {
    abrMode = 'auto';
    bandwidthSamples = [];
    lastSwitchTime = 0;
    buildQualityMenu();
    $qualityMenu.style.display = 'none';
  });
  $qualityMenu.appendChild(autoItem);

  // Individual quality options (highest first)
  for (let i = allVideoTracks.length - 1; i >= 0; i--) {
    const track = allVideoTracks[i];
    const label = formatQualityLabel(track);
    const item = document.createElement('div');
    const isActive = abrMode !== 'auto' && currentQualityIdx === i;
    item.className = 'q-item' + (isActive ? ' active' : '');
    item.innerHTML = `<span class="q-dot"></span>${label}`;
    item.addEventListener('click', ((idx) => () => {
      abrMode = idx;
      if (idx !== currentQualityIdx) switchVideoQuality(idx);
      buildQualityMenu();
      $qualityMenu.style.display = 'none';
    })(i));
    $qualityMenu.appendChild(item);
  }
}

if ($btnQuality) {
  $btnQuality.addEventListener('click', (e) => {
    e.stopPropagation();
    if ($qualityMenu.style.display === 'none') {
      buildQualityMenu();
      $qualityMenu.style.display = 'block';
    } else {
      $qualityMenu.style.display = 'none';
    }
  });
}

document.addEventListener('click', (e) => {
  if ($qualityMenu && $qualityGroup && !$qualityGroup.contains(e.target)) {
    $qualityMenu.style.display = 'none';
  }
});

// ─── Buffering Indicator ─────────────────────────────────────────────
$video.addEventListener('waiting', () => { $bufferingOverlay.style.display = 'flex'; });
$video.addEventListener('playing', () => { $bufferingOverlay.style.display = 'none'; });
$video.addEventListener('canplay', () => { $bufferingOverlay.style.display = 'none'; });

// ─── Video Error Handler ─────────────────────────────────────────────
$video.addEventListener('error', () => {
  const err = $video.error;
  if (!err) return;
  const msgs = {
    1: 'Playback aborted.',
    2: 'A network error occurred.',
    3: 'Media decode failed. The content may be corrupted.',
    4: 'Media format not supported by this browser.',
  };
  showError(msgs[err.code] || 'An unknown playback error occurred (code ' + err.code + ').');
});

// ─── Auto-Hide Controls ──────────────────────────────────────────────
function showControls() {
  $controls.classList.remove('hidden');
  document.body.style.cursor = '';
  clearTimeout(controlsIdleTimer);
  controlsIdleTimer = setTimeout(hideControls, 3000);
}

function hideControls() {
  if ($video.paused) return;
  $controls.classList.add('hidden');
  document.body.style.cursor = 'none';
}

$container.addEventListener('mousemove', showControls);
$container.addEventListener('mouseenter', showControls);
$container.addEventListener('mouseleave', () => { if (!$video.paused) hideControls(); });
$video.addEventListener('pause', showControls);
$video.addEventListener('play', () => { controlsIdleTimer = setTimeout(hideControls, 3000); });

// ─── Seek Helper ─────────────────────────────────────────────────────
function seekByDelta(deltaSec) {
  const target = Math.max(0, Math.min(duration, $video.currentTime + deltaSec));
  if (isTimeBuffered(target)) {
    $video.currentTime = target;
  } else {
    handleSeekToUnbuffered(target);
  }
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p' || e.key === 'S' || e.key === 'P')) {
    e.preventDefault();
    return;
  }
  if (e.key === 'PrintScreen') { e.preventDefault(); return; }

  if ($container.style.display === 'none') return;

  switch (e.key) {
    case ' ':
    case 'k':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekByDelta(-5);
      showControls();
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekByDelta(5);
      showControls();
      break;
    case 'j':
      e.preventDefault();
      seekByDelta(-10);
      showControls();
      break;
    case 'l':
      e.preventDefault();
      seekByDelta(10);
      showControls();
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.getElementById('player-root').requestFullscreen();
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      $video.muted = !$video.muted;
      $volumeBar.value = $video.muted ? '0' : String(Math.round($video.volume * 100));
      updateMuteIcon();
      showControls();
      break;
    case 'ArrowUp':
      e.preventDefault();
      $video.volume = Math.min(1, $video.volume + 0.1);
      $volumeBar.value = String(Math.round($video.volume * 100));
      updateMuteIcon();
      showControls();
      break;
    case 'ArrowDown':
      e.preventDefault();
      $video.volume = Math.max(0, $video.volume - 0.1);
      $volumeBar.value = String(Math.round($video.volume * 100));
      updateMuteIcon();
      showControls();
      break;
  }
});

// ─── Anti-Piracy ─────────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());
$video.addEventListener('enterpictureinpicture', () => {
  document.exitPictureInPicture().catch(() => {});
});
$video.disablePictureInPicture = true;
$video.addEventListener('dragstart', e => e.preventDefault());

// ─── Start ───────────────────────────────────────────────────────────
init();
