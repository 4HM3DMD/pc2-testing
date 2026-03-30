import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ParticleNetworkProvider from './particle/Provider';
import App from './App.tsx'

// Intercept fetch to log all Particle API responses (debug: pc2.net project email login)
const _origFetch = window.fetch;
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
  const resp = await _origFetch(...args);
  if (url.includes('particle')) {
    const clone = resp.clone();
    try {
      const body = await clone.text();
      console.log('[Particle API DEBUG]', resp.status, url.slice(0, 120), body.slice(0, 500));
    } catch {}
  }
  return resp;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ParticleNetworkProvider>
      <App />
    </ParticleNetworkProvider>
  </StrictMode>,
)
