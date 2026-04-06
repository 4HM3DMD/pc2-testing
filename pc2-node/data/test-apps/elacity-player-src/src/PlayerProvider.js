import React from 'react';
import * as PlayerCore from '@elacity-js/media-player';
const PlayerContext = React.createContext({
    moduleLoaded: false,
    loading: false,
    playerSupported: false,
    error: null,
});
export const PlayerProvider = ({ children, provider, address, }) => {
    const [state, setState] = React.useState({
        moduleLoaded: false,
        loading: false,
        playerSupported: Boolean(window.MediaSource) || Boolean(window.ManagedMediaSource),
        error: null,
    });
    React.useEffect(() => {
        if (state.loading || state.moduleLoaded)
            return;
        setState(s => ({ ...s, loading: true }));
        PlayerCore.setup({
            remote: true,
            drmSystem: {
                'cenc:lit-drm-v1': { priority: 1 },
                'cenc:lit-drm-sa-v1': { priority: 0 },
                'cenc:web3-drm-v1': { priority: 10, disabled: true },
            },
        })
            .then(() => setState(s => ({ ...s, moduleLoaded: true, loading: false })))
            .catch((err) => setState(s => ({ ...s, loading: false, error: err.message })));
    }, [state.loading, state.moduleLoaded]);
    React.useEffect(() => {
        if (state.moduleLoaded && provider) {
            const args = [provider];
            if (address)
                args.push(address);
            PlayerCore.setProvider(...args);
        }
    }, [state.moduleLoaded, provider, address]);
    return (<PlayerContext.Provider value={state}>
      {children}
    </PlayerContext.Provider>);
};
export const usePlayerContext = () => React.useContext(PlayerContext);
//# sourceMappingURL=PlayerProvider.js.map