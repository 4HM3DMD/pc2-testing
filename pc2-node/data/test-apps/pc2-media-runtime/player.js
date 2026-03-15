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
const BUYER_ADDRESS = params.buyerAddress || '';
const REQUEST_ID = params.requestId || '';
const LIT_AUTH_SIG = params.litAuthSig || null;

// ─── DOM ─────────────────────────────────────────────────────────────
const $loading = document.getElementById('loading-screen');
const $loadingText = document.getElementById('loading-text');
const $error = document.getElementById('error-screen');
const $errorText = document.getElementById('error-text');
const $container = document.getElementById('player-container');
const $video = document.getElementById('video');
const $watermark = document.getElementById('watermark');
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
const $btnFullscreen = document.getElementById('btn-fullscreen');

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
const BUFFER_AHEAD_SEGMENTS = 3;

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

// ─── MSE Engine ──────────────────────────────────────────────────────
async function fetchSegment(trackIndex, segmentNumber, init) {
  const body = { sessionId, trackIndex };
  if (init) body.init = true;
  else body.segmentNumber = segmentNumber;

  const res = await apiFetch('/api/media/segment', body);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to fetch segment');
  }
  return await res.arrayBuffer();
}

function appendToSourceBuffer(sb, data, queue, setAppending) {
  return new Promise((resolve, reject) => {
    if (sb.updating) {
      queue.push({ data, resolve, reject });
      return;
    }
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

async function loadSegments(trackIndex, sb, queue, setAppending, nextSegRef, segCount, type) {
  const buffered = sb.buffered;
  const currentTime = $video.currentTime;
  let bufferedEnd = 0;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && buffered.end(i) > bufferedEnd) {
      bufferedEnd = buffered.end(i);
    }
  }

  while (nextSegRef.val < segCount && nextSegRef.val - getPlayingSegment(currentTime, trackIndex) < BUFFER_AHEAD_SEGMENTS) {
    try {
      const data = await fetchSegment(trackIndex, nextSegRef.val, false);
      await appendToSourceBuffer(sb, data, queue, setAppending);
      nextSegRef.val++;
    } catch (e) {
      console.error(`[${type}] Segment ${nextSegRef.val} failed:`, e);
      break;
    }
  }

  if (nextSegRef.val >= segCount && !sb.updating) {
    return true; // All segments loaded
  }
  return false;
}

function getPlayingSegment(time, trackIndex) {
  const track = tracks[trackIndex];
  if (!track || !track.segments) return 0;
  // Approximate: find segment containing current time
  let elapsed = 0;
  for (let i = 0; i < track.segments.length; i++) {
    elapsed += track.segments[i].duration;
    if (elapsed > time) return i;
  }
  return track.segments.length;
}

// ─── Init ────────────────────────────────────────────────────────────
async function init() {
  if (!CHANNEL || !TOKEN_ID) {
    showError('Missing channel or tokenId parameters.');
    return;
  }

  $loadingText.textContent = 'Resolving content and recovering decryption key...';

  try {
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

    // Set window title
    if (data.title) {
      document.title = data.title + ' — PC2 Media Player';
    }

    // Pick tracks — choose lowest bandwidth video for initial load, first audio
    const videoTracks = tracks.filter(t => t.type === 'video').sort((a, b) => a.bandwidth - b.bandwidth);
    const audioTracks = tracks.filter(t => t.type === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);

    if (videoTracks.length > 0) {
      // Pick a medium quality (middle of sorted list)
      const midIdx = Math.min(Math.floor(videoTracks.length / 2), videoTracks.length - 1);
      videoTrackIdx = videoTracks[midIdx].index;
      videoSegCount = videoTracks[midIdx].segmentCount;
    }
    if (audioTracks.length > 0) {
      audioTrackIdx = audioTracks[0].index;
      audioSegCount = audioTracks[0].segmentCount;
    }

    if (videoTrackIdx === -1 && audioTrackIdx === -1) {
      showError('No playable tracks found in content.');
      return;
    }

    // Set watermark
    const sp = new URLSearchParams(window.location.search);
    const addr = sp.get('puter.smart_account') || params.buyerAddress || '';
    if (addr) {
      $watermark.textContent = addr.substring(0, 10) + '...' + addr.substring(addr.length - 6) + '\n' + new Date().toISOString().split('T')[0];
    }

    $loadingText.textContent = 'Buffering media segments...';

    // Setup MSE
    if (!window.MediaSource) {
      showError('MediaSource API not available in this browser.');
      return;
    }

    mediaSource = new MediaSource();
    $video.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', async () => {
      try {
        // Add source buffers
        if (videoTrackIdx !== -1) {
          const vTrack = tracks[videoTrackIdx];
          const vCodec = `${vTrack.mimeType}; codecs="${vTrack.codec}"`;
          console.log('[player] addSourceBuffer video:', vCodec);
          videoSB = mediaSource.addSourceBuffer(vCodec);
        }
        if (audioTrackIdx !== -1) {
          const aTrack = tracks[audioTrackIdx];
          const aCodec = `${aTrack.mimeType}; codecs="${aTrack.codec}"`;
          console.log('[player] addSourceBuffer audio:', aCodec);
          audioSB = mediaSource.addSourceBuffer(aCodec);
        }

        // Fetch and append init segments
        if (videoSB) {
          console.log('[player] Appending video init segment...');
          const initData = await fetchSegment(videoTrackIdx, 0, true);
          console.log('[player] Video init fetched:', initData.byteLength, 'bytes');
          await appendToSourceBuffer(videoSB, initData, videoSegmentQueue, v => isAppendingVideo = v);
          console.log('[player] Video init appended OK');
        }
        if (audioSB) {
          console.log('[player] Appending audio init segment...');
          const initData = await fetchSegment(audioTrackIdx, 0, true);
          console.log('[player] Audio init fetched:', initData.byteLength, 'bytes');
          await appendToSourceBuffer(audioSB, initData, audioSegmentQueue, v => isAppendingAudio = v);
          console.log('[player] Audio init appended OK');
        }

        // Load first batch of segments
        videoNextSeg = 0;
        audioNextSeg = 0;

        if (videoSB) {
          for (let i = 0; i < BUFFER_AHEAD_SEGMENTS && videoNextSeg < videoSegCount; i++) {
            console.log('[player] Appending video seg', videoNextSeg);
            const data = await fetchSegment(videoTrackIdx, videoNextSeg, false);
            await appendToSourceBuffer(videoSB, data, videoSegmentQueue, v => isAppendingVideo = v);
            videoNextSeg++;
          }
          console.log('[player] Video buffered', videoNextSeg, 'segments');
        }
        if (audioSB) {
          for (let i = 0; i < BUFFER_AHEAD_SEGMENTS && audioNextSeg < audioSegCount; i++) {
            console.log('[player] Appending audio seg', audioNextSeg);
            const data = await fetchSegment(audioTrackIdx, audioNextSeg, false);
            await appendToSourceBuffer(audioSB, data, audioSegmentQueue, v => isAppendingAudio = v);
            audioNextSeg++;
          }
          console.log('[player] Audio buffered', audioNextSeg, 'segments');
        }

        // Show player
        $loading.style.display = 'none';
        $container.style.display = 'flex';
        $timeDuration.textContent = formatTime(duration);
        $seekBar.max = String(duration);

        // Start continuous buffering
        startBufferLoop();

      } catch (e) {
        const msg = e.message || e.type || (typeof e === 'string' ? e : JSON.stringify(e));
        console.error('[player] Buffer error:', e);
        showError('Failed to buffer media: ' + msg);
      }
    });

  } catch (e) {
    showError('Initialization failed: ' + e.message);
  }
}

function startBufferLoop() {
  setInterval(async () => {
    let videoAllDone = videoTrackIdx === -1;
    let audioAllDone = audioTrackIdx === -1;

    if (videoSB && videoNextSeg < videoSegCount && !isAppendingVideo) {
      const bufEnd = getBufferedEnd(videoSB);
      if (bufEnd - $video.currentTime < 10) {
        try {
          const data = await fetchSegment(videoTrackIdx, videoNextSeg, false);
          await appendToSourceBuffer(videoSB, data, videoSegmentQueue, v => isAppendingVideo = v);
          videoNextSeg++;
        } catch { /* retry next tick */ }
      }
    }
    if (videoNextSeg >= videoSegCount) videoAllDone = true;

    if (audioSB && audioNextSeg < audioSegCount && !isAppendingAudio) {
      const bufEnd = getBufferedEnd(audioSB);
      if (bufEnd - $video.currentTime < 10) {
        try {
          const data = await fetchSegment(audioTrackIdx, audioNextSeg, false);
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

function getBufferedEnd(sb) {
  if (!sb || sb.buffered.length === 0) return 0;
  let maxEnd = 0;
  for (let i = 0; i < sb.buffered.length; i++) {
    if (sb.buffered.end(i) > maxEnd) maxEnd = sb.buffered.end(i);
  }
  return maxEnd;
}

// ─── Controls ────────────────────────────────────────────────────────
$btnPlay.addEventListener('click', () => {
  if ($video.paused) $video.play();
  else $video.pause();
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
  $video.currentTime = parseFloat($seekBar.value);
});

function updateBufferedBar() {
  if (!$video.buffered.length) return;
  const end = $video.buffered.end($video.buffered.length - 1);
  $seekBuffered.style.width = (end / duration * 100) + '%';
}

$volumeBar.addEventListener('input', () => { $video.volume = parseInt($volumeBar.value) / 100; });
$btnMute.addEventListener('click', () => {
  $video.muted = !$video.muted;
  $volumeBar.value = $video.muted ? '0' : String(Math.round($video.volume * 100));
});
$video.volume = 0.8;

$btnFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.getElementById('player-root').requestFullscreen();
});

// ─── Anti-Piracy ─────────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'p' || e.key === 'S' || e.key === 'P')) e.preventDefault();
  if (e.key === 'PrintScreen') e.preventDefault();
});
$video.addEventListener('enterpictureinpicture', e => {
  document.exitPictureInPicture().catch(() => {});
});
$video.disablePictureInPicture = true;

// Block drag
$video.addEventListener('dragstart', e => e.preventDefault());

// ─── Start ───────────────────────────────────────────────────────────
init();
