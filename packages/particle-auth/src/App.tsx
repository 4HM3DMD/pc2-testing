import React from 'react';
import './App.css';
import { useModal } from '@particle-network/connectkit';
import { useParticleNetwork } from './particle/hooks/useParticleNetwork';
import elacityLogo from './assets/elacity-labs-logo.svg';


function App() {
  const { setOpen, isOpen } = useModal();
  const { active, account, eoaAddress, universalAccount } = useParticleNetwork();
  
  // Check if we're in a background mode (hidden iframe for data fetching or signing)
  const { isWalletMode, isSigningMode } = React.useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    return { isWalletMode: mode === 'wallet', isSigningMode: mode === 'signing' };
  }, []);
  
  const isBackgroundMode = isWalletMode || isSigningMode;
  
  React.useEffect(() => {
    if (isBackgroundMode) {
      console.log('[Particle Auth]: Background mode status -', { active, eoaAddress, isOpen, isSigningMode });
    }
  }, [isBackgroundMode, active, eoaAddress, isOpen, isSigningMode]);
  
  React.useEffect(() => {
    // Wallet mode: always suppress the ConnectKit login modal
    if (isWalletMode) {
      if (isOpen) setOpen(false);
      return;
    }
    
    // Signing mode: only suppress the ConnectKit login modal during session restore.
    // Once active (session restored), stop fighting modal state so Particle's
    // Auth Core signing confirmation (Shadow DOM) can render freely.
    if (isSigningMode) {
      if (!active && isOpen) {
        console.log('[Particle Auth Signing]: Suppressing login modal during session restore');
        setOpen(false);
      }
      return;
    }
    
    // Normal mode - open modal if not active
    if(!active) {
      setOpen(true);
    } else {
      if (isOpen && import.meta.env.VITE_DEV_SANDBOX !== 'true') {
        setOpen(false);
      }
    }
  }, [setOpen, active, isOpen, isWalletMode, isSigningMode]);

  // Wallet mode: ensure fully transparent background when iframe becomes visible for signing.
  // color-scheme: light dark causes browsers to apply an opaque dark canvas — override it.
  // Also watch for Particle's Shadow DOM and make its backdrop transparent.
  React.useEffect(() => {
    if (!isWalletMode) return;
    const html = document.documentElement;
    const body = document.body;
    html.style.colorScheme = 'normal';
    html.style.backgroundColor = 'transparent';
    body.style.backgroundColor = 'transparent';

    const makeShadowBackdropTransparent = (host: HTMLElement) => {
      const sr = host.shadowRoot;
      if (!sr) return;

      const style = document.createElement('style');
      style.textContent = `
        :host { background: transparent !important; }
        .ant-drawer-mask, [class*="mask"], [class*="Mask"] {
          background: transparent !important;
          background-color: transparent !important;
        }
      `;
      sr.appendChild(style);

      const fixBackdropElements = () => {
        sr.querySelectorAll('div').forEach((div) => {
          if (!(div instanceof HTMLElement)) return;
          const s = div.style;
          if ((s.position === 'fixed' || s.position === 'absolute') &&
              (s.inset === '0px' || (s.top === '0px' && s.left === '0px' && s.right === '0px' && s.bottom === '0px'))) {
            div.style.setProperty('background', 'transparent', 'important');
            div.style.setProperty('background-color', 'transparent', 'important');
          }
        });
      };

      fixBackdropElements();
      const innerObs = new MutationObserver(fixBackdropElements);
      innerObs.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.shadowRoot) {
            makeShadowBackdropTransparent(node);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.body.querySelectorAll('*').forEach((el) => {
      if (el instanceof HTMLElement && el.shadowRoot) {
        makeShadowBackdropTransparent(el);
      }
    });

    return () => observer.disconnect();
  }, [isWalletMode]);

  // Signing mode: override body/html CSS for proper Particle rendering
  React.useEffect(() => {
    if (!isSigningMode) return;
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');

    const prevBodyDisplay = body.style.display;
    const prevBodyPlaceItems = body.style.placeItems;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyBg = body.style.backgroundColor;
    const prevHtmlOverflow = html.style.overflow;
    const prevHtmlBg = html.style.backgroundColor;
    const prevRootOverflow = root?.style.overflow || '';

    body.style.display = 'block';
    body.style.placeItems = '';
    body.style.overflow = 'visible';
    body.style.backgroundColor = '#1C1D22';
    html.style.overflow = 'visible';
    html.style.backgroundColor = '#1C1D22';
    if (root) {
      root.style.overflow = 'visible';
    }

    return () => {
      body.style.display = prevBodyDisplay;
      body.style.placeItems = prevBodyPlaceItems;
      body.style.overflow = prevBodyOverflow;
      body.style.backgroundColor = prevBodyBg;
      html.style.overflow = prevHtmlOverflow;
      html.style.backgroundColor = prevHtmlBg;
      if (root) root.style.overflow = prevRootOverflow;
    };
  }, [isSigningMode]);
  
  // Wallet mode: detect when Particle's Shadow DOM modal appears/disappears
  // and notify parent so it can show/hide the iframe overlay
  React.useEffect(() => {
    if (!isWalletMode) return;
    const html = document.documentElement;
    const body = document.body;
    html.style.colorScheme = 'normal';
    html.style.backgroundColor = 'transparent';
    body.style.backgroundColor = 'transparent';

    let trackedHost: HTMLElement | null = null;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.shadowRoot) {
            trackedHost = node;
            window.parent.postMessage({ type: 'particle-signing.modal-opened' }, '*');
          }
        }
        for (const node of m.removedNodes) {
          if (node === trackedHost) {
            trackedHost = null;
            window.parent.postMessage({ type: 'particle-signing.modal-closed' }, '*');
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: false });
    return () => observer.disconnect();
  }, [isWalletMode]);

  // Wallet mode: render nothing (hidden data iframe)
  if (isWalletMode) {
    return null;
  }
  
  // Signing mode: render nothing — Particle's signing UI renders via Shadow DOM portal
  if (isSigningMode) {
    return null;
  }
  
  return (
    <a 
      href="https://elacitylabs.com" 
      target="_blank" 
      rel="noopener noreferrer"
      className="presented-by"
    >
      <span>Presented by</span>
      <img src={elacityLogo} alt="Elacity Labs" />
    </a>
  );
}

export default App;
