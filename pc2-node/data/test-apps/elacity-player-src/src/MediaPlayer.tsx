import React from 'react';
import {
  create as createPlayer,
  ElacityMediaPlayer,
  PlayerSignal,
} from '@elacity-js/media-player';
import { usePlayerContext } from './PlayerProvider';

interface MediaPlayerProps {
  title: string;
  source: string;
  ledger: string;
  tokenId: string;
  thumbnail?: string;
}

export const MediaPlayer: React.FC<MediaPlayerProps> = ({
  title,
  source,
  ledger,
  tokenId,
  thumbnail,
}) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const playerRef = React.useRef<ElacityMediaPlayer | null>(null);
  const initializingRef = React.useRef(false);
  const playTriggeredRef = React.useRef(false);
  const { moduleLoaded } = usePlayerContext();
  const [status, setStatus] = React.useState('Initializing player...');
  const [error, setError] = React.useState<string | null>(null);

  const autoplay = new URLSearchParams(window.location.search).get('autoplay') === 'true';

  React.useEffect(() => {
    let mounted = true;
    const video = videoRef.current;

    if (!video || !moduleLoaded || playerRef.current || initializingRef.current) return;

    initializingRef.current = true;
    playTriggeredRef.current = false;
    setStatus('Creating player instance...');

    const handleSignRequest = () => {
      if (mounted) setStatus('Requesting wallet signature for DRM...');
    };

    const triggerPlay = (player: ElacityMediaPlayer) => {
      if (playTriggeredRef.current) return;
      playTriggeredRef.current = true;
      if (mounted) setStatus('Starting playback...');
      player.play({ fromts: 0 })
        .then((signal: PlayerSignal) => {
          if (mounted) setStatus('Playing');
          initializingRef.current = false;
        })
        .catch((err: Error) => {
          console.error('[Player] Play error:', err);
          playTriggeredRef.current = false;
          if (mounted) setError('Play failed: ' + err.message);
        });
    };

    createPlayer(
      ledger,
      tokenId,
      video,
      source,
      {
        onBeforePlay: async () => {
          if (mounted) setStatus('Preparing playback...');
        },
        thumbnail,
        handlebars: { title, author: '', thumbnail },
        logLevel: 2,
      }
    )
      .then((player) => {
        if (!mounted) return;

        playerRef.current = player;
        setStatus('Player created, loading stream...');

        player.addEventListener('certificate', () => {
          if (mounted) setStatus('DRM certificate received...');
        });
        player.addEventListener('sign_request', handleSignRequest);
        player.addEventListener('sign_error', (e: Event) => {
          const detail = (e as CustomEvent).detail;
          console.error('[Player] Sign error', detail);
          if (mounted) setError('DRM signing error: ' + (detail?.message || JSON.stringify(detail)));
        });
        player.addEventListener('error', (e: Event) => {
          const detail = (e as CustomEvent).detail;
          console.error('[Player] Error event', detail);
          if (mounted) setError('Player error: ' + (detail?.message || JSON.stringify(detail)));
        });

        player.addEventListener('statechanged', (e: Event) => {
          const ce = e as CustomEvent<{ state: string }>;
          const state = ce.detail.state;
          if (mounted) setStatus('State: ' + state);

          if ((state === 'loaded' || state === 'ready') && autoplay) {
            triggerPlay(player);
          }
        });

        if (autoplay) {
          setTimeout(() => {
            if (!playTriggeredRef.current && mounted) {
              triggerPlay(player);
            }
          }, 1500);
        }
      })
      .catch((err: Error) => {
        console.error('[Player] Create error:', err);
        if (mounted) setError('Failed to create player: ' + err.message);
        initializingRef.current = false;
      });

    return () => {
      mounted = false;
      if (playerRef.current) {
        playerRef.current.removeEventListener('sign_request', handleSignRequest);
        playerRef.current = null;
      }
    };
  }, [moduleLoaded, source, ledger, tokenId, title, thumbnail, autoplay]);

  return (
    <div style={{ flex: 1, background: '#000', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {error && (
        <div style={{ padding: '12px 16px', background: '#7f1d1d', color: '#fca5a5', fontSize: 13 }}>
          {error}
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 48, left: 12, right: 12, color: '#64748b', fontSize: 11, zIndex: 1, pointerEvents: 'none' }}>
        {!error && status !== 'Playing' && status}
        {!window.crossOriginIsolated && <span style={{ marginLeft: 8, color: '#f59e0b' }}>[No SharedArrayBuffer]</span>}
      </div>
      <video
        ref={videoRef}
        autoPlay={false}
        controls
        preload="none"
        poster={thumbnail}
        crossOrigin="anonymous"
        style={{ width: '100%', flex: 1, objectFit: 'contain' }}
      />
    </div>
  );
};
