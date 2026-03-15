import React from 'react';
import { PlayerProvider } from './PlayerProvider';
import { PlayerView } from './PlayerView';

export const App: React.FC = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [provider, setProvider] = React.useState<any>(window.ethereum);
  const [address, setAddress] = React.useState<string | undefined>();
  const [connecting, setConnecting] = React.useState(true);

  React.useEffect(() => {
    if (!provider) {
      const timer = setTimeout(() => {
        if (window.ethereum) {
          setProvider(window.ethereum);
        } else {
          setConnecting(false);
        }
      }, 2000);
      return () => clearTimeout(timer);
    }

    let cancelled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const puterArgs = (window as any).puter?.args;
    const urlSmartAccount = puterArgs?.smartAccount || new URLSearchParams(window.location.search).get('smartAccount');

    const onAccountsChanged = (accounts: string[]) => {
      if (cancelled) return;
      if (urlSmartAccount) {
        setAddress(urlSmartAccount);
      } else if (provider.smartAccountAddress) {
        setAddress(provider.smartAccountAddress);
      } else if (accounts.length > 0) {
        setAddress(accounts[0]);
      }
      setConnecting(false);
    };

    provider.on('accountsChanged', onAccountsChanged);

    provider.request({ method: 'eth_requestAccounts' })
      .then((accounts: string[]) => {
        if (cancelled) return;
        if (urlSmartAccount) {
          setAddress(urlSmartAccount);
          setConnecting(false);
          return;
        }
        return provider.request({ method: 'pc2_getSmartAccountAddress' })
          .then((sa: string | null) => {
            if (cancelled) return;
            setAddress(sa || (accounts?.length ? accounts[0] : undefined));
            setConnecting(false);
          })
          .catch(() => {
            if (cancelled) return;
            setAddress(accounts?.length ? accounts[0] : undefined);
            setConnecting(false);
          });
      })
      .catch(() => {
        if (!cancelled) setConnecting(false);
      });

    return () => {
      cancelled = true;
      provider.removeListener('accountsChanged', onAccountsChanged);
    };
  }, [provider]);

  if (connecting) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#94a3b8' }}>
        <p>Connecting to PC2 wallet...</p>
      </div>
    );
  }

  if (!provider || !address) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#94a3b8', gap: 16, padding: 32, textAlign: 'center' }}>
        <h2 style={{ color: '#e2e8f0', fontSize: 18 }}>Wallet Not Connected</h2>
        <p>Could not connect to PC2 wallet. Please ensure you are logged in.</p>
        <button
          onClick={() => {
            setConnecting(true);
            if (window.ethereum) setProvider(window.ethereum);
          }}
          style={{ marginTop: 8, padding: '8px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <PlayerProvider provider={provider} address={address}>
      <PlayerView />
    </PlayerProvider>
  );
};
