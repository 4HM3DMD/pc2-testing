/**
 * UIWindowParticleSigning - Show the Particle iframe for transaction signing
 *
 * Makes the hidden data iframe visible as a centered overlay so the user
 * can interact with Particle's signing UI. Restores hidden state after
 * completion, rejection, dismiss, or timeout.
 *
 * Supports:
 *   - eth_sendTransaction → posts particle-wallet.eoa-send
 *   - personal_sign       → posts particle-wallet.eoa-send with method override
 */

const RESULT_TIMEOUT_MS = 60000;
const HIDDEN_STYLE = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;visibility:hidden;';

async function UIWindowParticleSigning({ method, params }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const iframe = document.getElementById('particle-wallet-iframe');
        if (!iframe) {
            reject(new Error('Particle iframe not available'));
            return;
        }

        const requestId = `signing-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483640;';
        document.body.appendChild(backdrop);

        const dismissBtn = document.createElement('button');
        dismissBtn.innerHTML = '&times;';
        dismissBtn.title = 'Cancel transaction';
        dismissBtn.style.cssText = 'position:fixed;z-index:2147483643;width:36px;height:36px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);background:rgba(0,0,0,0.7);color:#fff;font-size:22px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;top:16px;right:16px;';
        document.body.appendChild(dismissBtn);

        const savedStyle = iframe.style.cssText;
        iframe.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:440px;height:calc(100vh - 60px);max-height:720px;border:none;z-index:2147483641;background:transparent;border-radius:12px;visibility:visible;overflow:hidden;';

        function cleanup(fn, val) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            window.removeEventListener('message', messageHandler);
            iframe.style.cssText = savedStyle || HIDDEN_STYLE;
            backdrop.remove();
            dismissBtn.remove();
            delete window._particleSigningAbort;
            fn(val);
        }

        dismissBtn.addEventListener('click', () => {
            cleanup(reject, new Error('User cancelled signing'));
        });

        backdrop.addEventListener('click', () => {
            cleanup(reject, new Error('User cancelled signing'));
        });

        window._particleSigningAbort = (reason) => {
            cleanup(reject, new Error(reason || 'Cancelled'));
        };

        const timeout = setTimeout(() => {
            cleanup(resolve, 'pending');
        }, RESULT_TIMEOUT_MS);

        function messageHandler(event) {
            if (event.origin !== window.location.origin) return;
            const { type, requestId: respId, payload } = event.data || {};
            if (respId !== requestId) return;

            if (type === 'particle-wallet.eoa-send-result') {
                cleanup(resolve, payload?.txHash || payload?.signature);
            }
            if (type === 'particle-wallet.rpc-result') {
                cleanup(resolve, payload?.result);
            }
            if (type === 'particle-wallet.error') {
                cleanup(reject, new Error(payload?.message || 'Signing failed'));
            }
        }

        window.addEventListener('message', messageHandler);

        if (method === 'personal_sign') {
            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.eoa-send',
                requestId,
                payload: {
                    method: 'personal_sign',
                    params: params,
                },
            }, '*');
        } else {
            const txObj = params?.[0] || {};
            const { chainId: chainIdHex, ...txParams } = txObj;
            const chainId = chainIdHex ? parseInt(chainIdHex, 16) : undefined;

            iframe.contentWindow?.postMessage({
                type: 'particle-wallet.eoa-send',
                requestId,
                payload: { txParams, chainId },
            }, '*');
        }
    });
}

export default UIWindowParticleSigning;
