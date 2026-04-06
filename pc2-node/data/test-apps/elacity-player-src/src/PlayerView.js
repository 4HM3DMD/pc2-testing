import React from 'react';
import { ElacityClient } from '@elacity-js/api';
import { usePlayerContext } from './PlayerProvider';
import { MediaPlayer } from './MediaPlayer';
function getParam(key) {
    const puterVal = window.puter?.args?.[key];
    if (puterVal)
        return puterVal;
    return new URLSearchParams(window.location.search).get(key);
}
function getGateway() {
    return getParam('gateway') || (window.location.origin + '/ipfs/');
}
function getFallbackGateway() {
    return getParam('fallbackGateway') || 'https://ipfs.ela.city/ipfs/';
}
function resolveIpfsUrl(url) {
    if (!url)
        return '';
    if (url.startsWith('ipfs://'))
        return getGateway() + url.slice(7);
    return url;
}
export const PlayerView = () => {
    const { moduleLoaded, loading, playerSupported, error: playerError } = usePlayerContext();
    const [resolved, setResolved] = React.useState(null);
    const [resolving, setResolving] = React.useState(false);
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
        const channel = getParam('channel');
        const tokenId = getParam('tokenId');
        if (!channel || !tokenId) {
            setError('Missing channel or tokenId URL parameters');
            return;
        }
        setResolving(true);
        const client = new ElacityClient({ chainId: 8453 });
        client.nfts.retrieveItem(channel, tokenId)
            .then((item) => {
            if (!item)
                throw new Error('NFT not found');
            const mediaUri = item.metadata?.media?.uri;
            if (!mediaUri)
                throw new Error('No media source in NFT metadata');
            setResolved({
                title: item.metadata?.name ?? item.name ?? 'Untitled',
                thumbnail: item.image ? resolveIpfsUrl(item.image) : undefined,
                source: resolveIpfsUrl(mediaUri + '/stream.mpd'),
                ledger: channel,
                tokenId,
            });
        })
            .catch((err) => setError(err.message))
            .finally(() => setResolving(false));
    }, []);
    if (error || playerError) {
        return (<div style={styles.container}>
        <div style={styles.errorBox}>
          <h2 style={{ marginBottom: 8 }}>Player Error</h2>
          <p>{error || playerError}</p>
        </div>
      </div>);
    }
    if (!playerSupported) {
        return (<div style={styles.container}>
        <div style={styles.errorBox}>
          <h2 style={{ marginBottom: 8 }}>Player Not Supported</h2>
          <p>MediaSource API is required for playback but is not available in this browser.</p>
        </div>
      </div>);
    }
    if (loading || resolving || !moduleLoaded) {
        return (<div style={styles.container}>
        <div style={styles.loadingBox}>
          <div style={styles.spinner}/>
          <p style={{ marginTop: 16, color: '#94a3b8' }}>
            {loading ? 'Loading WASM player module...' : resolving ? 'Resolving NFT metadata...' : 'Initializing...'}
          </p>
        </div>
      </div>);
    }
    if (!resolved) {
        return (<div style={styles.container}>
        <p style={{ color: '#94a3b8' }}>No content to play.</p>
      </div>);
    }
    return (<div style={styles.playerContainer}>
      <div style={styles.header}>
        <h1 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>{resolved.title}</h1>
      </div>
      <MediaPlayer title={resolved.title} source={resolved.source} ledger={resolved.ledger} tokenId={resolved.tokenId} thumbnail={resolved.thumbnail}/>
    </div>);
};
const styles = {
    container: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        padding: 24,
    },
    errorBox: {
        background: '#1e1b2e',
        border: '1px solid #7f1d1d',
        borderRadius: 12,
        padding: 24,
        maxWidth: 480,
        color: '#fca5a5',
    },
    loadingBox: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
    },
    spinner: {
        width: 40,
        height: 40,
        border: '3px solid #334155',
        borderTopColor: '#6366f1',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
    },
    playerContainer: {
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#000',
    },
    header: {
        padding: '12px 16px',
        background: '#0f172a',
        borderBottom: '1px solid #1e293b',
    },
};
//# sourceMappingURL=PlayerView.js.map