import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
try {
    const raw = new URLSearchParams(window.location.search).get('puter.args');
    if (raw) {
        window.puter = { ...(window.puter || {}), args: JSON.parse(raw) };
    }
}
catch { }
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode>
    <App />
  </React.StrictMode>);
//# sourceMappingURL=main.js.map