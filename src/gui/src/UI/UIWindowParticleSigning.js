/**
 * UIWindowParticleSigning - Show the Particle iframe for transaction signing
 *
 * Two completely different paths depending on how the user logged in:
 *
 * 1. EMBEDDED (email / social via Particle Auth)
 *    Surface the persistent /particle-auth?mode=wallet iframe as a centered
 *    modal so the user can interact with Particle's in-iframe signing UI.
 *
 * 2. WALLETCONNECT
 *    The mode=wallet iframe was built for token-data REST calls and does
 *    NOT run ConnectKit's reconnectOnMount — so connector.getProvider()
 *    is undefined and signing requests die with "Provider not ready"
 *    after 9s of retries (see Elacity NFT diagnosis).
 *    Instead, spawn a transient /particle-auth?mode=signing iframe per
 *    request. Signing mode runs the full ConnectKit boot sequence,
 *    restores the WC session from localStorage, and only signals ready
 *    when there's a real connector + EOA. Show a corner toast so the
 *    user knows to check their wallet app, since the iframe stays hidden.
 *
 * Method routing (must match handlers in particle-auth ParticleNetworkContext):
 *   - eth_sendTransaction / eth_signTransaction
 *       → particle-wallet.eoa-send  { txParams, chainId }   (embedded)
 *       → particle-signing.rpc      { method, params }      (WC)
 *   - personal_sign
 *       → particle-wallet.eoa-send  { method, params }      (embedded)
 *       → particle-signing.rpc      { method, params }      (WC)
 *   - eth_signTypedData / _v3 / _v4 / eth_sign
 *       → particle-wallet.rpc       { method, params }      (embedded)
 *       → particle-signing.rpc      { method, params }      (WC)
 */

// Reduced from 45s to 30s (v1.2.1): the WC hint already escalates at 8s and
// 20s, so by the time we'd hit 45s the user has been told twice the session
// may be dead — they're not still waiting hopefully, they're stuck. Cut the
// dead-air to 30s and replace the generic "Signing timed out" with an
// actionable message so the user can recover instead of refreshing in
// frustration. Diagnosed from a real Elastos NFT failure log where the
// dApp's chain-switch error left the WC session in a state where Essentials
// silently dropped the personal_sign request.
const RESULT_TIMEOUT_MS = 30000;
const TIMEOUT_MESSAGE = 'Your wallet didn\u2019t respond in 30s. Open Essentials and check for a pending request, or close this dialog and try again. If the dApp asked your wallet to switch chains, you may need to switch manually in Essentials first (WalletConnect doesn\u2019t support programmatic chain switching).';
const HIDDEN_STYLE = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;visibility:hidden;';
const OVERLAY_ATTR = 'data-particle-signing-overlay';

function removeStaleOverlays() {
    document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach(el => el.remove());
}

function stopEvent(e) {
    e.stopPropagation();
    e.stopImmediatePropagation();
}

function getLoginMethod() {
    try {
        return (
            (window.user && window.user.login_method) ||
            localStorage.getItem('pc2_login_method') ||
            'email'
        ).toLowerCase();
    } catch (_) {
        return 'email';
    }
}

const TYPED_DATA_METHODS = ['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'];
const TX_METHODS = ['eth_sendTransaction', 'eth_signTransaction'];

// External wallets (MM extension / WC) only know the EOA. dApps frequently
// pass the smart-account address as the signer because they read it from
// window.user — every wallet then silently rejects (no popup, no error).
// Rewriting the signer slot to the connected EOA before posting to the
// iframe is what makes the wallet actually prompt the user.
function normalizeSignerAddress(method, params) {
    const eoa = window.user && window.user.wallet_address;
    if (!eoa || !Array.isArray(params)) return params;
    const next = [...params];
    // personal_sign: [message, signer]
    if (method === 'personal_sign') {
        if (!next[1] || String(next[1]).toLowerCase() !== eoa.toLowerCase()) next[1] = eoa;
        return next;
    }
    // eth_sign / eth_signTypedData*: [signer, payload]
    if (method === 'eth_sign' || TYPED_DATA_METHODS.indexOf(method) !== -1) {
        if (!next[0] || String(next[0]).toLowerCase() !== eoa.toLowerCase()) next[0] = eoa;
        return next;
    }
    return params;
}

// Compact bottom-right status panel for WalletConnect signing. Lives in the
// corner so it doesn't block the dApp window the user is interacting with —
// previous centered overlay covered Elacity NFT / Glide UIs and felt very
// intrusive. Visual language stays in sync with the SIWE bridge overlay
// (UIWindowParticleLogin.js → showLoginStatusOverlay).
function buildWalletConnectPanel({ method }) {
    if (!document.querySelector('style#pc2-signing-status-style')) {
        const style = document.createElement('style');
        style.id = 'pc2-signing-status-style';
        style.textContent = `
            @keyframes pc2-signing-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
            @keyframes pc2-signing-slide { 0%{transform:translateY(20px);opacity:0} 100%{transform:translateY(0);opacity:1} }
        `;
        document.head.appendChild(style);
    }
    const isTx = method === 'eth_sendTransaction' || method === 'eth_signTransaction';
    const title = isTx ? 'Confirm in your wallet' : 'Sign in your wallet';
    const message = isTx
        ? 'Open Essentials (or your WalletConnect wallet) and approve the transaction.'
        : 'Open Essentials (or your WalletConnect wallet) and approve the signature.';
    const methodLabel = method || 'sign';
    const wrapper = document.createElement('div');
    wrapper.setAttribute(OVERLAY_ATTR, 'wc-panel');
    wrapper.style.cssText = `
        position: fixed; right: 24px; bottom: 24px;
        z-index: 2147483642;
        background: #1c1c1e;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 14px 16px 14px 14px;
        width: 320px;
        box-shadow: 0 18px 40px -12px rgba(0,0,0,0.65);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: pc2-signing-slide 220ms cubic-bezier(.2,.9,.3,1) both;
        display: flex; gap: 12px; align-items: flex-start;
    `;
    wrapper.innerHTML = `
        <div style="
            flex: 0 0 auto; width: 36px; height: 36px;
            border-radius: 50%;
            background: rgba(245, 158, 11, 0.10);
            display: flex; align-items: center; justify-content: center;
            position: relative;
        ">
            <div style="
                position: absolute; inset: 0;
                border: 2px solid rgba(245, 158, 11, 0.18);
                border-top-color: #f59e0b;
                border-radius: 50%;
                animation: pc2-signing-spin .9s linear infinite;
            "></div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
        </div>
        <div style="flex: 1 1 auto; min-width: 0;">
            <div style="font-size: 13px; font-weight: 600; color: #ffffff; margin-bottom: 3px; letter-spacing: -0.01em;">
                ${title}
            </div>
            <div data-wc-msg style="font-size: 12px; color: #9ca3af; line-height: 1.4;">
                ${message}
            </div>
            <div data-wc-meta style="margin-top: 6px; font-size: 10px; color: #4b5563; font-family: ui-monospace, monospace;">
                ${methodLabel}
            </div>
            <div data-wc-hint style="margin-top: 6px; font-size: 11px; color: #6b7280; min-height: 0;"></div>
        </div>
        <button data-wc-cancel title="Cancel" style="
            flex: 0 0 auto; width: 24px; height: 24px;
            border: none; background: transparent; color: #6b7280;
            font-size: 18px; line-height: 1; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 6px; padding: 0; font-family: inherit;
        ">&times;</button>
    `;
    return wrapper;
}

// Cached signing-mode iframe — first WC sign request mounts it (~3s for
// ConnectKit + WC relay reconnect), subsequent requests reuse it instantly.
let _signingIframePromise = null;

function getOrCreateSigningIframe() {
    if (_signingIframePromise) return _signingIframePromise;

    _signingIframePromise = new Promise((resolve, reject) => {
        let existing = document.getElementById('particle-signing-iframe');
        if (existing) {
            existing.remove();
        }

        const iframe = document.createElement('iframe');
        iframe.id = 'particle-signing-iframe';
        iframe.setAttribute('allowtransparency', 'true');
        iframe.style.cssText = HIDDEN_STYLE;

        const params = new URLSearchParams({
            mode: 'signing',
            _t: Date.now().toString(),
        });
        iframe.src = `/particle-auth?${params.toString()}`;
        document.body.appendChild(iframe);

        let resolved = false;
        const readyHandler = (event) => {
            if (event.data && event.data.type === 'particle-signing.ready') {
                if (resolved) return;
                resolved = true;
                window.removeEventListener('message', readyHandler);
                clearTimeout(readyTimer);
                console.log('[UIWindowParticleSigning] signing iframe ready, address:', event.data.payload?.address);
                resolve(iframe);
            }
        };
        const readyTimer = setTimeout(() => {
            if (resolved) return;
            window.removeEventListener('message', readyHandler);
            _signingIframePromise = null; // allow retry on next call
            iframe.remove();
            reject(new Error('Wallet signing iframe failed to restore your WalletConnect session within 15s. Open Essentials, reconnect to PC2, then try again.'));
        }, 15000);

        window.addEventListener('message', readyHandler);
    });

    _signingIframePromise.catch(() => {
        _signingIframePromise = null;
    });

    return _signingIframePromise;
}

async function signViaSigningIframe({ method, params }) {
    const sigParams = normalizeSignerAddress(method, params);
    const iframe = await getOrCreateSigningIframe();

    return new Promise((resolve, reject) => {
        let settled = false;
        const requestId = `signing-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const onMessage = (event) => {
            const { type, requestId: respId, payload } = event.data || {};
            if (respId !== requestId) return;

            if (type === 'particle-signing.rpc-result') {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                resolve(payload?.result);
            }
            if (type === 'particle-wallet.error') {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                reject(new Error(payload?.message || 'Signing failed'));
            }
        };
        window.addEventListener('message', onMessage);

        console.log('[UIWindowParticleSigning] post particle-signing.rpc:', method, '— signer:', method === 'personal_sign' ? sigParams?.[1] : sigParams?.[0]);
        iframe.contentWindow?.postMessage({
            type: 'particle-signing.rpc',
            requestId,
            payload: { method, params: sigParams },
        }, '*');
    });
}

async function signViaWalletIframe({ method, params }) {
    const iframe = document.getElementById('particle-wallet-iframe');
    if (!iframe) throw new Error('Particle iframe not available');

    return new Promise((resolve, reject) => {
        let settled = false;
        const requestId = `signing-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const onMessage = (event) => {
            const { type, requestId: respId, payload } = event.data || {};
            if (respId !== requestId) return;
            if (type === 'particle-wallet.eoa-send-result') {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                resolve(payload?.txHash || payload?.signature);
            }
            if (type === 'particle-wallet.rpc-result') {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                resolve(payload?.result);
            }
            if (type === 'particle-wallet.error') {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', onMessage);
                reject(new Error(payload?.message || 'Signing failed'));
            }
        };
        window.addEventListener('message', onMessage);

        if (method === 'personal_sign') {
            const signParams = normalizeSignerAddress('personal_sign', params);
            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.eoa-send',
                requestId,
                payload: { method: 'personal_sign', params: signParams },
            }, '*');
        } else if (TYPED_DATA_METHODS.indexOf(method) !== -1 || method === 'eth_sign') {
            const sigParams = normalizeSignerAddress(method, params);
            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.rpc',
                requestId,
                payload: { method, params: sigParams },
            }, '*');
        } else if (TX_METHODS.indexOf(method) !== -1) {
            const txObj = params?.[0] || {};
            const { chainId: chainIdHex, ...txParams } = txObj;
            const chainId = chainIdHex ? parseInt(chainIdHex, 16) : undefined;
            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.eoa-send',
                requestId,
                payload: { txParams, chainId },
            }, '*');
        } else {
            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.rpc',
                requestId,
                payload: { method, params },
            }, '*');
        }
    });
}

async function UIWindowParticleSigning({ method, params }) {
    removeStaleOverlays();

    const isWalletConnect = getLoginMethod() === 'walletconnect';
    let wcPanel = null;
    let wcHintTimer = null;
    let backdrop = null;
    let dismissBtn = null;
    const walletIframe = document.getElementById('particle-wallet-iframe');
    const savedWalletIframeStyle = walletIframe?.style.cssText;

    let cancelled = false;
    const cancelDeferred = { reject: null };
    const cancelPromise = new Promise((_, reject) => { cancelDeferred.reject = reject; });

    const cleanup = () => {
        if (wcHintTimer) clearTimeout(wcHintTimer);
        if (wcPanel && wcPanel.parentNode) wcPanel.parentNode.removeChild(wcPanel);
        if (backdrop) backdrop.remove();
        if (dismissBtn) dismissBtn.remove();
        if (walletIframe && savedWalletIframeStyle !== undefined) walletIframe.style.cssText = savedWalletIframeStyle;
        delete window._particleSigningAbort;
        removeStaleOverlays();
    };

    const triggerCancel = (reason) => {
        if (cancelled) return;
        cancelled = true;
        cancelDeferred.reject(new Error(reason || 'User cancelled signing'));
    };
    window._particleSigningAbort = triggerCancel;

    if (isWalletConnect) {
        wcPanel = buildWalletConnectPanel({ method });
        document.body.appendChild(wcPanel);
        const cancelBtn = wcPanel.querySelector('[data-wc-cancel]');
        if (cancelBtn) cancelBtn.addEventListener('click', (e) => { stopEvent(e); triggerCancel(); });
        wcHintTimer = setTimeout(() => {
            const hint = wcPanel?.querySelector('[data-wc-hint]');
            if (hint) hint.textContent = 'Still waiting — open Essentials and tap the pending request.';
            wcHintTimer = setTimeout(() => {
                const hint2 = wcPanel?.querySelector('[data-wc-hint]');
                if (hint2) hint2.textContent = "If your wallet didn't prompt you, close this and try again — your WC session may have dropped.";
            }, 12000);
        }, 8000);
    } else {
        backdrop = document.createElement('div');
        backdrop.setAttribute(OVERLAY_ATTR, 'backdrop');
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483640;';
        backdrop.addEventListener('mousedown', stopEvent, true);
        backdrop.addEventListener('mouseup', stopEvent, true);
        backdrop.addEventListener('pointerdown', stopEvent, true);
        backdrop.addEventListener('pointerup', stopEvent, true);
        backdrop.addEventListener('click', (e) => { stopEvent(e); triggerCancel(); });
        document.body.appendChild(backdrop);

        dismissBtn = document.createElement('button');
        dismissBtn.innerHTML = '&times;';
        dismissBtn.title = 'Cancel';
        dismissBtn.setAttribute(OVERLAY_ATTR, 'dismiss');
        dismissBtn.style.cssText = 'position:fixed;z-index:2147483643;width:36px;height:36px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);background:rgba(0,0,0,0.7);color:#fff;font-size:22px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;top:16px;right:16px;';
        dismissBtn.addEventListener('click', (e) => { stopEvent(e); triggerCancel(); });
        document.body.appendChild(dismissBtn);

        if (walletIframe) {
            walletIframe.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:440px;height:calc(100vh - 60px);max-height:720px;border:none;z-index:2147483641;background:transparent;border-radius:12px;visibility:visible;overflow:hidden;';
        }
    }

    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error(TIMEOUT_MESSAGE)), RESULT_TIMEOUT_MS));

    try {
        const signing = isWalletConnect
            ? signViaSigningIframe({ method, params })
            : signViaWalletIframe({ method, params });
        const result = await Promise.race([signing, cancelPromise, timeoutPromise]);
        console.log('[UIWindowParticleSigning] resolved:', method, typeof result === 'string' ? result.slice(0, 20) + '...' : result);
        cleanup();
        return result;
    } catch (err) {
        console.warn('[UIWindowParticleSigning] rejected:', method, err?.message);
        cleanup();
        throw err;
    }
}

export default UIWindowParticleSigning;
export { removeStaleOverlays };
