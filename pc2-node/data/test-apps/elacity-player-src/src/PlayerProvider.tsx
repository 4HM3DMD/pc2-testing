import React from 'react';
import * as PlayerCore from '@elacity-js/media-player';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalletProvider = any;

declare global {
  interface Window {
    ManagedMediaSource: MediaSource;
    ethereum?: WalletProvider;
  }
}

interface PlayerContextValue {
  moduleLoaded: boolean;
  loading: boolean;
  playerSupported: boolean;
  error: string | null;
}

const PlayerContext = React.createContext<PlayerContextValue>({
  moduleLoaded: false,
  loading: false,
  playerSupported: false,
  error: null,
});

interface PlayerProviderProps {
  provider: WalletProvider;
  address?: string;
}

export const PlayerProvider: React.FC<React.PropsWithChildren<PlayerProviderProps>> = ({
  children,
  provider,
  address,
}) => {
  const [state, setState] = React.useState<PlayerContextValue>({
    moduleLoaded: false,
    loading: false,
    playerSupported:
      Boolean(window.MediaSource) || Boolean(window.ManagedMediaSource),
    error: null,
  });

  React.useEffect(() => {
    if (state.loading || state.moduleLoaded) return;

    setState(s => ({ ...s, loading: true }));

    PlayerCore.setup({
      remote: true,
      drmSystem: {
        // Unified chipotle media protection (PSSH-driven)
        'cenc:lit-aes-gcm-v3': { priority: 0 },
        // Legacy fallback entries for previously minted assets
        'cenc:lit-drm-sa-v1': { priority: 1 },
        'cenc:lit-drm-v1': { priority: 2 },
        'cenc:web3-drm-v1': { priority: 10, disabled: true },
      },
    })
      .then(() => setState(s => ({ ...s, moduleLoaded: true, loading: false })))
      .catch((err: Error) => setState(s => ({ ...s, loading: false, error: err.message })));
  }, [state.loading, state.moduleLoaded]);

  React.useEffect(() => {
    if (state.moduleLoaded && provider) {
      const args: Parameters<typeof PlayerCore.setProvider> = [provider];
      if (address) args.push(address);
      PlayerCore.setProvider(...args);
    }
  }, [state.moduleLoaded, provider, address]);

  return (
    <PlayerContext.Provider value={state}>
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayerContext = () => React.useContext(PlayerContext);
