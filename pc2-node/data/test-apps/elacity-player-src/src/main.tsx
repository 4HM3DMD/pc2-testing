import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

// Parse puter.args from URL (passed by launch_app when running inside PC2)
try {
  const raw = new URLSearchParams(window.location.search).get('puter.args');
  if (raw) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).puter = { ...((window as any).puter || {}), args: JSON.parse(raw) };
  }
} catch { /* ignore parse errors */ }

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
