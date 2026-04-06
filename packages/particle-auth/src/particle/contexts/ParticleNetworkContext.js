import React from 'react';
import { isAddress } from '@ethersproject/address';
import { useAccount, useDisconnect, useWallets, } from '@particle-network/connectkit';
import { UniversalAccount, SUPPORTED_TOKEN_TYPE, } from '@particle-network/universal-account-sdk';
import { Web3Provider } from '../provider/web3-provider';
console.log('[Particle Auth Context]: BUILD v2026.03.30.pc2net loaded');
export const ParticleNetworkContext = React.createContext({
    deactivate: () => { },
});
function toSmallestUnit(amount, decimals) {
    if (!amount || amount === '0')
        return BigInt(0);
    const amountStr = amount.toString().trim();
    const [whole, fraction = ''] = amountStr.split('.');
    const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    const combined = whole + paddedFraction;
    const cleaned = combined.replace(/^0+/, '') || '0';
    return BigInt(cleaned);
}
function encodeERC20Transfer(to, amount, decimals = 18) {
    const functionSelector = '0xa9059cbb';
    const paddedTo = to.toLowerCase().replace('0x', '').padStart(64, '0');
    const amountInSmallestUnit = toSmallestUnit(amount, decimals);
    const amountHex = amountInSmallestUnit.toString(16).padStart(64, '0');
    return functionSelector + paddedTo + amountHex;
}
const ParticleNetworkProvider = React.memo(({ children, }) => {
    const { address: connectedEoaAddress, chainId, connector, } = useAccount();
    const [primaryWallet] = useWallets();
    const { disconnect } = useDisconnect();
    const [particleProvider, setParticleProvider] = React.useState();
    const isLogoutPendingRef = React.useRef(false);
    const [universalAccount, setUniversalAccount] = React.useState(null);
    const [smartAccountInfo, setSmartAccountInfo] = React.useState();
    const [primaryAssets, setPrimaryAssets] = React.useState();
    const { isWalletMode, isSigningMode, urlEoaAddress, urlSmartAddress, shouldLogout } = React.useMemo(() => {
        const params = new URLSearchParams(window.location.search);
        const mode = params.get('mode');
        return {
            isWalletMode: mode === 'wallet',
            isSigningMode: mode === 'signing',
            urlEoaAddress: params.get('address') || undefined,
            urlSmartAddress: params.get('smartAddress') || undefined,
            shouldLogout: params.get('logout') === 'true',
        };
    }, []);
    React.useEffect(() => {
        if (shouldLogout && connectedEoaAddress) {
            console.log('[Particle Auth]: Logout requested, disconnecting wallet...');
            disconnect({ connector });
            const url = new URL(window.location.href);
            url.searchParams.delete('logout');
            window.history.replaceState({}, '', url.toString());
        }
    }, [shouldLogout, connectedEoaAddress, disconnect, connector]);
    const eoaAddress = connectedEoaAddress || ((isWalletMode || isSigningMode) ? urlEoaAddress : undefined);
    const library = React.useMemo(() => (particleProvider ? new Web3Provider(particleProvider) : null), [particleProvider]);
    React.useEffect(() => {
        const getProvider = async () => {
            const provider = await primaryWallet.connector.getProvider();
            setParticleProvider(provider);
        };
        if (connectedEoaAddress && primaryWallet) {
            getProvider();
        }
    }, [primaryWallet, connectedEoaAddress]);
    const deactivate = React.useCallback(() => {
        disconnect({ connector });
    }, [disconnect, connector]);
    const active = React.useMemo(() => {
        if (isWalletMode && eoaAddress) {
            console.log('[Particle Auth]: Wallet mode active with URL address:', eoaAddress, '(provider:', !!library, ')');
            return true;
        }
        const hasAuth = !!(eoaAddress && library);
        if (isSigningMode) {
            console.log('[Particle Auth]: Signing mode session status:', { hasAuth, connectedEoaAddress, hasLibrary: !!library });
        }
        return hasAuth;
    }, [library, eoaAddress, isWalletMode, isSigningMode, connectedEoaAddress]);
    React.useEffect(() => {
        if (!active) {
            setParticleProvider(null);
            setUniversalAccount(null);
            setSmartAccountInfo(undefined);
            setPrimaryAssets(undefined);
        }
    }, [active]);
    React.useEffect(() => {
        if (active && eoaAddress) {
            const projectId = import.meta.env.VITE_PARTICLE_PROJECT_ID;
            const clientKey = import.meta.env.VITE_PARTICLE_CLIENT_KEY;
            const appId = import.meta.env.VITE_PARTICLE_APP_ID;
            const uaProjectId = import.meta.env.VITE_UA_PROJECT_ID || projectId;
            const uaClientKey = import.meta.env.VITE_UA_CLIENT_KEY || clientKey;
            const uaAppId = import.meta.env.VITE_UA_APP_ID || appId;
            if (projectId && clientKey && appId) {
                console.log('[Particle Auth]: Initializing UniversalAccount for EOA:', eoaAddress, isWalletMode ? '(wallet mode)' : '');
                console.log('[Particle Auth]: UA credentials:', uaProjectId !== projectId ? 'using Elacity project' : 'using default project');
                const ua = new UniversalAccount({
                    projectId: uaProjectId,
                    projectClientKey: uaClientKey,
                    projectAppUuid: uaAppId,
                    ownerAddress: eoaAddress,
                });
                setUniversalAccount(ua);
                if (isWalletMode && urlSmartAddress) {
                    console.log('[Particle Auth]: Smart Account hint from URL:', urlSmartAddress);
                    setSmartAccountInfo({
                        ownerAddress: eoaAddress,
                        smartAccountAddress: urlSmartAddress,
                    });
                }
            }
            else {
                console.warn('[Particle Auth]: Missing Particle credentials for UniversalAccount');
            }
        }
    }, [active, eoaAddress, isWalletMode, urlSmartAddress]);
    React.useEffect(() => {
        if (universalAccount && eoaAddress) {
            const fetchSmartAccountInfo = async () => {
                try {
                    const options = await universalAccount.getSmartAccountOptions();
                    console.log('[Particle Auth]: Smart Account Options (full):', JSON.stringify(options, null, 2));
                    console.log('[Particle Auth]: options.smartAccountAddress:', options.smartAccountAddress);
                    console.log('[Particle Auth]: options.solanaSmartAccountAddress:', options.solanaSmartAccountAddress);
                    console.log('[Particle Auth]: options.senderSolanaAddress:', options.senderSolanaAddress);
                    const solanaAddr = options.solanaSmartAccountAddress
                        || options.senderSolanaAddress
                        || options.solanaAddress
                        || '';
                    setSmartAccountInfo({
                        ownerAddress: eoaAddress,
                        smartAccountAddress: options.smartAccountAddress || '',
                        solanaSmartAccountAddress: solanaAddr,
                    });
                    console.log('[Particle Auth]: Using Smart Account (EVM):', options.smartAccountAddress);
                    console.log('[Particle Auth]: Using Smart Account (Solana):', solanaAddr || 'Not available');
                }
                catch (error) {
                    console.error('[Particle Auth]: Failed to get Smart Account options:', error);
                }
            };
            fetchSmartAccountInfo();
        }
    }, [universalAccount, eoaAddress]);
    const fetchPrimaryAssets = React.useCallback(async () => {
        if (!universalAccount)
            return;
        try {
            const assets = await universalAccount.getPrimaryAssets();
            console.log('[Particle Auth]: Primary Assets:', assets);
            setPrimaryAssets(assets);
        }
        catch (error) {
            console.warn('[Particle Auth]: Failed to fetch primary assets:', error);
        }
    }, [universalAccount]);
    React.useEffect(() => {
        if (universalAccount) {
            fetchPrimaryAssets();
        }
    }, [universalAccount, fetchPrimaryAssets]);
    const handleParticleAuthSuccess = React.useCallback(async () => {
        if (isLogoutPendingRef.current) {
            console.log('[Particle Auth]: Auth skipped — logout pending, ignoring auto-reconnect');
            isLogoutPendingRef.current = false;
            return;
        }
        try {
            const authPayload = {
                address: eoaAddress,
                chainId,
            };
            if (smartAccountInfo?.smartAccountAddress) {
                authPayload.smartAccountAddress = smartAccountInfo.smartAccountAddress;
                console.log('[Particle Auth]: Sending auth with Smart Account:', smartAccountInfo.smartAccountAddress);
            }
            else {
                console.log('[Particle Auth]: Sending auth with EOA only (Smart Account not ready yet)');
            }
            let apiOrigin = window.PUTER_API_ORIGIN || import.meta.env.VITE_PUTER_API_URL || window.location.origin;
            if (window.location.protocol === 'https:' && apiOrigin.startsWith('http://')) {
                apiOrigin = apiOrigin.replace('http://', 'https://');
            }
            console.log('[Particle Auth]: Auth callback using API origin:', apiOrigin);
            const response = await fetch(`${apiOrigin}/auth/particle`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(authPayload),
            });
            const data = await response.json();
            let isInIframe = false;
            try {
                isInIframe = window !== window.parent || window.self !== window.top;
            }
            catch (e) {
                isInIframe = true;
            }
            console.log('[Particle Auth]: isInIframe detection:', isInIframe, 'window !== parent:', window !== window.parent, 'self !== top:', window.self !== window.top);
            const messageTarget = isInIframe ? window.parent : window;
            if (data.success) {
                const connectorId = connector?.id || connector?.name || '';
                const loginMethod = connectorId.toLowerCase().includes('metamask') ? 'metamask'
                    : connectorId.toLowerCase().includes('walletconnect') ? 'walletconnect'
                        : connectorId.toLowerCase().includes('coinbase') ? 'coinbase'
                            : 'email';
                console.log('[Particle Auth]: Auth SUCCESS, loginMethod:', loginMethod, 'connector:', connectorId);
                messageTarget.postMessage({
                    type: 'particle-auth.success',
                    payload: {
                        address: eoaAddress,
                        smartAccountAddress: smartAccountInfo?.smartAccountAddress,
                        chainId,
                        token: data.token,
                        user: data.user,
                        loginMethod,
                    }
                }, '*');
                if (!isInIframe && import.meta.env.VITE_DEV_SANDBOX !== 'true') {
                    console.log('[Particle Auth]: Standalone mode, redirecting to main app');
                    window.location.href = `/?auth_token=${data.token}`;
                }
                else {
                    console.log('[Particle Auth]: In iframe, NOT redirecting (parent handles it)');
                }
            }
            else {
                console.error('Authentication failed:', data.error, data.message);
                if (data.error === 'access_denied') {
                    console.log('[Particle Auth]: Access denied, redirecting to access-denied page');
                    const deniedUrl = `/access-denied?wallet=${encodeURIComponent(data.wallet || eoaAddress)}`;
                    if (!isInIframe) {
                        window.location.href = deniedUrl;
                    }
                    else {
                        messageTarget.postMessage({
                            type: 'particle-auth.access-denied',
                            payload: {
                                wallet: data.wallet || eoaAddress,
                                message: data.message,
                                redirectUrl: deniedUrl,
                            }
                        }, '*');
                    }
                    return;
                }
                messageTarget.postMessage({
                    type: 'particle-auth.error',
                    payload: {
                        message: `failed to authenticate: ${data.message}`,
                    }
                }, '*');
            }
        }
        catch (error) {
            console.error('Authentication error:', error);
            const isInIframe = window !== window.parent;
            const messageTarget = isInIframe ? window.parent : window;
            messageTarget.postMessage({
                type: 'particle-auth.error',
                payload: {
                    message: `authentication error: ${error}`,
                }
            }, '*');
        }
    }, [eoaAddress, chainId, smartAccountInfo]);
    React.useEffect(() => {
        if (!active)
            return;
        if (shouldLogout) {
            console.log('[Particle Auth]: Skipping auth (logout requested)');
            return;
        }
        if (isWalletMode || isSigningMode) {
            console.log('[Particle Auth Wallet Mode]: Skipping auth callback (wallet mode)');
            return;
        }
        const timeoutId = setTimeout(() => {
            handleParticleAuthSuccess();
        }, smartAccountInfo?.smartAccountAddress ? 0 : 2000);
        return () => clearTimeout(timeoutId);
    }, [active, smartAccountInfo, handleParticleAuthSuccess, isWalletMode, shouldLogout]);
    React.useEffect(() => {
        let timeoutId;
        if (active) {
            const isDisconnecting = localStorage.getItem('disconnect_particle');
            if ((isDisconnecting)) {
                localStorage.removeItem('disconnect_particle');
                isLogoutPendingRef.current = true;
                deactivate();
            }
        }
        return () => {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        };
    }, [deactivate, active]);
    React.useEffect(() => {
        if (isSigningMode)
            return;
        if (isWalletMode && eoaAddress) {
            window.parent.postMessage({
                type: 'particle-wallet.ready',
                payload: { ready: true, address: eoaAddress },
            }, '*');
            return;
        }
        if (!connector || !connectedEoaAddress)
            return;
        window.parent.postMessage({
            type: 'particle-wallet.ready',
            payload: { ready: true, address: connectedEoaAddress },
        }, '*');
    }, [connector, connectedEoaAddress, isSigningMode, isWalletMode, eoaAddress]);
    React.useEffect(() => {
        if (!isSigningMode || !connector || !connectedEoaAddress)
            return;
        const handleSigningRpc = async (event) => {
            const { type, requestId, payload } = event.data || {};
            if (type !== 'particle-signing.rpc')
                return;
            try {
                const signingProvider = await connector.getProvider();
                if (!signingProvider)
                    throw new Error('Signer not available — session not restored');
                const { method: rpcMethod, params: rpcParams } = payload;
                if (rpcMethod === 'eth_accounts' || rpcMethod === 'eth_requestAccounts') {
                    window.parent.postMessage({
                        type: 'particle-signing.rpc-result',
                        requestId,
                        payload: { result: connectedEoaAddress ? [connectedEoaAddress] : [] },
                    }, '*');
                    return;
                }
                if (rpcMethod === 'eth_chainId') {
                    const currentChain = await signingProvider.request({ method: 'eth_chainId' });
                    window.parent.postMessage({
                        type: 'particle-signing.rpc-result',
                        requestId,
                        payload: { result: currentChain },
                    }, '*');
                    return;
                }
                if (rpcMethod === 'eth_sendTransaction' && rpcParams?.[0]?.chainId) {
                    const targetChainHex = rpcParams[0].chainId;
                    try {
                        await signingProvider.request({
                            method: 'wallet_switchEthereumChain',
                            params: [{ chainId: targetChainHex }],
                        });
                    }
                    catch (switchErr) {
                        console.log('[Particle Signing Handler] Chain switch info:', switchErr?.message || switchErr);
                    }
                    const { chainId: _removed, ...cleanParams } = rpcParams[0];
                    rpcParams[0] = cleanParams;
                }
                console.log('[Particle Signing Handler] Calling provider.request:', rpcMethod);
                const rpcResult = await signingProvider.request({ method: rpcMethod, params: rpcParams });
                console.log('[Particle Signing Handler] RPC result for', rpcMethod, ':', typeof rpcResult === 'string' ? rpcResult.substring(0, 20) + '...' : rpcResult);
                window.parent.postMessage({
                    type: 'particle-signing.rpc-result',
                    requestId,
                    payload: { result: rpcResult },
                }, '*');
            }
            catch (error) {
                console.error('[Particle Signing Handler] Error:', error);
                window.parent.postMessage({
                    type: 'particle-wallet.error',
                    requestId,
                    payload: { message: error.message || 'Signing failed' },
                }, '*');
            }
        };
        window.addEventListener('message', handleSigningRpc);
        console.log('[Particle Auth Signing]: RPC handler registered, signaling ready');
        window.parent.postMessage({
            type: 'particle-signing.ready',
            payload: { ready: true, address: connectedEoaAddress },
        }, '*');
        return () => window.removeEventListener('message', handleSigningRpc);
    }, [isSigningMode, connector, connectedEoaAddress]);
    React.useEffect(() => {
        if (!active || !universalAccount)
            return;
        console.log('[Particle Auth]: Wallet ready, signaling parent window');
        window.parent.postMessage({
            type: 'particle-wallet.ready',
            payload: {
                ready: true,
                address: eoaAddress,
                smartAccountAddress: smartAccountInfo?.smartAccountAddress,
            },
        }, '*');
        const handleWalletDataRequest = async (event) => {
            const { type, requestId, payload } = event.data || {};
            if (!type?.startsWith('particle-wallet.'))
                return;
            try {
                switch (type) {
                    case 'particle-wallet.get-tokens': {
                        console.log('[Particle Auth]: get-tokens handler called, universalAccount:', !!universalAccount);
                        console.log('[Particle Auth]: Calling getPrimaryAssets()...');
                        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('getPrimaryAssets() timed out after 15s')), 15000));
                        let assets;
                        try {
                            assets = await Promise.race([
                                universalAccount.getPrimaryAssets(),
                                timeoutPromise
                            ]);
                            console.log('[Particle Auth]: getPrimaryAssets() succeeded:', JSON.stringify(assets, null, 2));
                        }
                        catch (fetchError) {
                            console.error('[Particle Auth]: getPrimaryAssets() FAILED:', fetchError.message || fetchError);
                            window.parent.postMessage({
                                type: 'particle-wallet.tokens',
                                requestId,
                                payload: { tokens: [], totalBalance: 0, error: fetchError.message },
                            }, '*');
                            break;
                        }
                        const tokens = assets?.assets?.map((asset) => ({
                            symbol: (asset.tokenType || 'unknown').toUpperCase(),
                            name: asset.tokenType || 'Unknown Token',
                            address: asset.chainAggregation?.[0]?.token?.address || '0x0',
                            balance: asset.amount || 0,
                            decimals: asset.chainAggregation?.[0]?.token?.decimals || 18,
                            chainId: asset.chainAggregation?.[0]?.token?.chainId,
                            icon: null,
                            logoURI: null,
                            usdValue: asset.amountInUSD || 0,
                            price: asset.price || 0,
                            chainBreakdown: asset.chainAggregation?.map((chain) => ({
                                chainId: chain.token?.chainId,
                                amount: chain.amount,
                                amountInUSD: chain.amountInUSD,
                            })) || [],
                        })).filter((token) => token.balance > 0 || token.usdValue > 0) || [];
                        const totalBalance = assets?.totalAmountInUSD || 0;
                        console.log('[Particle Auth]: Sending tokens response:', { tokensCount: tokens.length, totalBalance, rawAssets: assets?.assets?.length });
                        window.parent.postMessage({
                            type: 'particle-wallet.tokens',
                            requestId,
                            payload: { tokens, totalBalance },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.get-transactions': {
                        const page = payload?.page || 1;
                        const limit = payload?.limit || 20;
                        console.log('[Particle Wallet Handler] Fetching transactions, page:', page, 'limit:', limit);
                        const txResponse = await universalAccount.getTransactions(page, limit);
                        const transactions = txResponse?.data || txResponse || [];
                        console.log('[Particle Wallet Handler] Transactions response:', transactions?.length || 0, 'items');
                        const formattedTxs = (Array.isArray(transactions) ? transactions : []).map((tx) => {
                            const rawAmount = parseFloat(tx.change?.amount || '0');
                            const isSend = rawAmount < 0;
                            const displayAmount = Math.abs(rawAmount).toString();
                            return {
                                transactionId: tx.transactionId,
                                hash: tx.transactionId,
                                tag: tx.tag,
                                type: isSend ? 'send' : 'receive',
                                createdAt: tx.createdAt,
                                timestamp: tx.createdAt,
                                status: tx.status,
                                symbol: tx.targetToken?.symbol || 'Unknown',
                                tokenName: tx.targetToken?.name || 'Unknown Token',
                                tokenIcon: tx.targetToken?.image,
                                tokenPrice: tx.targetToken?.price,
                                targetToken: {
                                    name: tx.targetToken?.name,
                                    symbol: tx.targetToken?.symbol,
                                    image: tx.targetToken?.image,
                                    type: tx.targetToken?.type,
                                    price: tx.targetToken?.price,
                                    chainId: tx.targetToken?.chainId,
                                },
                                amount: displayAmount,
                                rawAmount: tx.change?.amount,
                                amountInUSD: tx.change?.amountInUSD,
                                from: tx.change?.from,
                                to: tx.change?.to,
                                fromChains: tx.fromChains || [],
                                toChains: tx.toChains || [],
                                chainId: tx.targetToken?.chainId || tx.toChains?.[0],
                            };
                        });
                        console.log('[Particle Wallet Handler] Formatted transactions:', formattedTxs.length);
                        window.parent.postMessage({
                            type: 'particle-wallet.transactions',
                            requestId,
                            payload: {
                                transactions: formattedTxs,
                                hasMore: formattedTxs.length >= limit,
                                page,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.get-transaction-details': {
                        const { transactionId } = payload;
                        if (!transactionId) {
                            throw new Error('Transaction ID required');
                        }
                        console.log('[Particle Wallet Handler] Fetching transaction details:', transactionId);
                        const txDetails = await universalAccount.getTransaction(transactionId);
                        console.log('[Particle Wallet Handler] Transaction details:', txDetails);
                        const operations = [
                            ...(txDetails?.lendingUserOperations || []),
                            ...(txDetails?.depositUserOperations || []),
                            ...(txDetails?.userOperations || []),
                        ];
                        const operation = operations.find((op) => op?.txHash);
                        const blockchainTxHash = operation?.txHash || null;
                        const operationChainId = operation?.chainId || txDetails?.targetToken?.chainId;
                        console.log('[Particle Wallet Handler] Blockchain hash:', blockchainTxHash, 'chainId:', operationChainId);
                        window.parent.postMessage({
                            type: 'particle-wallet.transaction-details',
                            requestId,
                            payload: {
                                transactionId,
                                blockchainTxHash,
                                chainId: operationChainId,
                                details: txDetails,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.execute-universal-batch': {
                        if (!universalAccount || !smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart account not ready');
                        }
                        const { chainId: batchChainId, transactions: batchTxs, expectTokens: batchExpectTokens } = payload;
                        if (!batchChainId || !Array.isArray(batchTxs) || batchTxs.length === 0) {
                            throw new Error('chainId and non-empty transactions required');
                        }
                        const UNIVERSAL_CHECKIN = '0x2361a02e6727Ff1798920186b8ACf0f100f621C0';
                        const BASE_RPC = 'https://mainnet.base.org';
                        try {
                            const codeResp = await fetch(BASE_RPC, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    jsonrpc: '2.0', id: 1, method: 'eth_getCode',
                                    params: [smartAccountInfo.smartAccountAddress, 'latest'],
                                }),
                            });
                            const codeResult = await codeResp.json();
                            if (codeResult.result === '0x') {
                                console.log('[Particle Auth] Smart account not deployed, deploying via checkIn...');
                                const checkInData = '0x183ff085';
                                const deployTx = await universalAccount.createUniversalTransaction({
                                    chainId: batchChainId,
                                    expectTokens: [],
                                    transactions: [{ to: UNIVERSAL_CHECKIN, data: checkInData, value: '0x0' }],
                                });
                                const deployProvider = await connector?.getProvider();
                                if (!deployProvider)
                                    throw new Error('No wallet provider for deployment');
                                const deploySig = await deployProvider.request({
                                    method: 'personal_sign',
                                    params: [deployTx.rootHash, connectedEoaAddress],
                                });
                                await universalAccount.sendTransaction(deployTx, deploySig);
                                await new Promise((r) => setTimeout(r, 3000));
                                console.log('[Particle Auth] Smart account deployed successfully');
                            }
                        }
                        catch (deployErr) {
                            console.warn('[Particle Auth] Smart account assertion failed (continuing):', deployErr);
                        }
                        let diagInfo = {};
                        try {
                            const [diagAssets, diagSaOptions] = await Promise.all([
                                universalAccount.getPrimaryAssets(),
                                universalAccount.getSmartAccountOptions(),
                            ]);
                            diagInfo = {
                                totalUSD: diagAssets?.totalAmountInUSD,
                                assets: diagAssets?.assets?.map((a) => ({ type: a.tokenType, amount: a.amount, usd: a.amountInUSD })),
                                sdkSmartAccount: diagSaOptions?.smartAccountAddress,
                                localSmartAccount: smartAccountInfo.smartAccountAddress,
                                eoa: connectedEoaAddress,
                                expectTokens: batchExpectTokens || [],
                                batchTxCount: batchTxs?.length,
                                chainId: batchChainId,
                                sdkVersion: '1.0.7',
                            };
                            console.log('[Particle Auth] DIAGNOSTIC:', JSON.stringify(diagInfo));
                            window.parent.postMessage({ type: 'particle-wallet.diagnostic', payload: diagInfo }, '*');
                        }
                        catch (diagErr) {
                            diagInfo = { error: diagErr?.message };
                            console.warn('[Particle Auth] Diagnostic failed:', diagErr);
                            window.parent.postMessage({ type: 'particle-wallet.diagnostic', payload: diagInfo }, '*');
                        }
                        let transaction;
                        try {
                            const createPayload = {
                                chainId: batchChainId,
                                expectTokens: [],
                                transactions: batchTxs.map((t) => ({
                                    to: t.to,
                                    data: t.data,
                                    value: t.value || '0x0',
                                })),
                            };
                            const tradeConfig = { usePrimaryTokens: ['usdc'] };
                            console.log('[Particle Auth] createUniversalTransaction payload:', JSON.stringify(createPayload), 'tradeConfig:', JSON.stringify(tradeConfig));
                            window.parent.postMessage({ type: 'particle-wallet.diagnostic', payload: { step: 'createUniversalTransaction', params: createPayload, tradeConfig } }, '*');
                            transaction = await universalAccount.createUniversalTransaction(createPayload, tradeConfig);
                        }
                        catch (createErr) {
                            console.error('[Particle Auth] createUniversalTransaction FAILED:', createErr);
                            window.parent.postMessage({ type: 'particle-wallet.diagnostic', payload: {
                                    step: 'createUniversalTransaction-ERROR',
                                    error: createErr?.message,
                                    code: createErr?.code,
                                    fullError: String(createErr),
                                    diagInfo,
                                } }, '*');
                            throw createErr;
                        }
                        const batchProvider = await connector?.getProvider();
                        if (!batchProvider) {
                            throw new Error('No wallet provider available');
                        }
                        const signature = await batchProvider.request({
                            method: 'personal_sign',
                            params: [transaction.rootHash, connectedEoaAddress],
                        });
                        if (!signature?.length) {
                            throw new Error('Signature is empty, cannot send transaction');
                        }
                        const sendResult = await universalAccount.sendTransaction(transaction, signature);
                        const txId = sendResult?.transactionId || transaction?.transactionId;
                        const universalTxUrl = `https://universalx.app/activity/details?id=${txId}`;
                        console.log('[Particle Auth] UA transaction sent:', txId, universalTxUrl);
                        let onChainHash = null;
                        const POLL_INTERVAL = 2000;
                        const POLL_TIMEOUT = 60000;
                        const pollStart = Date.now();
                        while (Date.now() - pollStart < POLL_TIMEOUT) {
                            try {
                                const txStatus = await universalAccount.getTransaction(txId);
                                const status = txStatus?.status;
                                if (status === 6 || status === 10 || status === 14) {
                                    throw new Error(`UA transaction failed with status ${status}`);
                                }
                                const allOps = [
                                    ...(txStatus?.lendingUserOperations || []),
                                    ...(txStatus?.depositUserOperations || []),
                                    ...(txStatus?.settlementUserOperations || []),
                                    ...(txStatus?.refundUserOperations || []),
                                ];
                                const opWithHash = allOps.find((op) => op?.txHash);
                                if (opWithHash) {
                                    onChainHash = opWithHash.txHash;
                                    console.log('[Particle Auth] On-chain tx hash found:', onChainHash);
                                    break;
                                }
                                if (status === 7) {
                                    console.log('[Particle Auth] TX finished (status 7) but no txHash yet');
                                    break;
                                }
                            }
                            catch (pollErr) {
                                if (pollErr?.message?.includes('failed with status'))
                                    throw pollErr;
                                console.warn('[Particle Auth] Poll error (retrying):', pollErr?.message);
                            }
                            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
                        }
                        window.parent.postMessage({
                            type: 'particle-wallet.execute-universal-batch-result',
                            requestId,
                            payload: {
                                transactionId: txId,
                                transactionHash: onChainHash || sendResult?.transactionHash || sendResult?.hash,
                                universalTxUrl,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.execute-universal-batch-create': {
                        if (!universalAccount || !smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart account not ready');
                        }
                        const { chainId: createChainId, transactions: createTxs, expectTokens: createExpectTokens } = payload;
                        if (!createChainId || !Array.isArray(createTxs) || createTxs.length === 0) {
                            throw new Error('chainId and non-empty transactions required');
                        }
                        const CHECKIN_ADDR = '0x2361a02e6727Ff1798920186b8ACf0f100f621C0';
                        const RPC_URL = 'https://mainnet.base.org';
                        try {
                            const codeRes = await fetch(RPC_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [smartAccountInfo.smartAccountAddress, 'latest'] }),
                            });
                            const codeJson = await codeRes.json();
                            if (codeJson.result === '0x') {
                                console.log('[Particle Auth] Smart account not deployed, deploying via checkIn...');
                                const deployTx = await universalAccount.createUniversalTransaction({
                                    chainId: createChainId, expectTokens: [],
                                    transactions: [{ to: CHECKIN_ADDR, data: '0x183ff085', value: '0x0' }],
                                });
                                const deployProv = await connector?.getProvider();
                                if (!deployProv)
                                    throw new Error('No wallet provider for deployment');
                                const deploySig = await deployProv.request({ method: 'personal_sign', params: [deployTx.rootHash, connectedEoaAddress] });
                                await universalAccount.sendTransaction(deployTx, deploySig);
                                await new Promise((r) => setTimeout(r, 3000));
                            }
                        }
                        catch (deployErr) {
                            console.warn('[Particle Auth] Smart account assertion failed (continuing):', deployErr);
                        }
                        const createPayload = {
                            chainId: createChainId,
                            expectTokens: [],
                            transactions: createTxs.map((t) => ({ to: t.to, data: t.data, value: t.value || '0x0' })),
                        };
                        const tradeConfig = { usePrimaryTokens: ['usdc'] };
                        console.log('[Particle Auth] batch-create payload:', JSON.stringify(createPayload));
                        const createdBatchTx = await universalAccount.createUniversalTransaction(createPayload, tradeConfig);
                        window.parent.postMessage({
                            type: 'particle-wallet.execute-universal-batch-create-result',
                            requestId,
                            payload: {
                                rootHash: createdBatchTx.rootHash,
                                transactionData: JSON.parse(JSON.stringify(createdBatchTx)),
                                eoaAddress: connectedEoaAddress,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.execute-universal-batch-submit': {
                        if (!universalAccount) {
                            throw new Error('Universal account not ready');
                        }
                        const { transactionData: batchTxData, signature: batchSig } = payload;
                        const batchSendResult = await universalAccount.sendTransaction(batchTxData, batchSig);
                        const batchTxId = batchSendResult?.transactionId || batchTxData?.transactionId;
                        const batchUniversalTxUrl = `https://universalx.app/activity/details?id=${batchTxId}`;
                        console.log('[Particle Auth] UA batch submitted:', batchTxId, batchUniversalTxUrl);
                        let batchOnChainHash = null;
                        const BATCH_POLL_INTERVAL = 2000;
                        const BATCH_POLL_TIMEOUT = 60000;
                        const batchPollStart = Date.now();
                        while (Date.now() - batchPollStart < BATCH_POLL_TIMEOUT) {
                            try {
                                const batchTxStatus = await universalAccount.getTransaction(batchTxId);
                                const batchStatus = batchTxStatus?.status;
                                if (batchStatus === 6 || batchStatus === 10 || batchStatus === 14) {
                                    throw new Error(`UA transaction failed with status ${batchStatus}`);
                                }
                                const batchAllOps = [
                                    ...(batchTxStatus?.lendingUserOperations || []),
                                    ...(batchTxStatus?.depositUserOperations || []),
                                    ...(batchTxStatus?.settlementUserOperations || []),
                                    ...(batchTxStatus?.refundUserOperations || []),
                                ];
                                const batchOpWithHash = batchAllOps.find((op) => op?.txHash);
                                if (batchOpWithHash) {
                                    batchOnChainHash = batchOpWithHash.txHash;
                                    console.log('[Particle Auth] Batch on-chain hash:', batchOnChainHash);
                                    break;
                                }
                                if (batchStatus === 7)
                                    break;
                            }
                            catch (pollErr) {
                                if (pollErr?.message?.includes('failed with status'))
                                    throw pollErr;
                                console.warn('[Particle Auth] Batch poll error (retrying):', pollErr?.message);
                            }
                            await new Promise((r) => setTimeout(r, BATCH_POLL_INTERVAL));
                        }
                        window.parent.postMessage({
                            type: 'particle-wallet.execute-universal-batch-submit-result',
                            requestId,
                            payload: {
                                transactionId: batchTxId,
                                transactionHash: batchOnChainHash || batchSendResult?.transactionHash || batchSendResult?.hash,
                                universalTxUrl: batchUniversalTxUrl,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.eth-send-transaction': {
                        const provider = await connector?.getProvider();
                        if (!provider)
                            throw new Error('No wallet provider available');
                        const txParams = { ...payload.txParams, from: connectedEoaAddress };
                        const txHash = await provider.request({
                            method: 'eth_sendTransaction',
                            params: [txParams],
                        });
                        window.parent.postMessage({
                            type: 'particle-wallet.eth-send-transaction-result',
                            requestId,
                            payload: { txHash },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.eoa-send': {
                        console.log('[Particle Wallet Handler] eoa-send: connector?', !!connector, 'connectedEoa?', connectedEoaAddress, 'method?', payload.method);
                        let eoaProvider = await connector?.getProvider();
                        if (!eoaProvider) {
                            for (let attempt = 0; attempt < 3 && !eoaProvider; attempt++) {
                                console.log('[Particle Wallet Handler] Provider not ready, retrying...', attempt + 1);
                                await new Promise(r => setTimeout(r, 1500));
                                eoaProvider = await connector?.getProvider();
                            }
                        }
                        if (!eoaProvider)
                            throw new Error('No wallet provider available — session may not be restored. Try logging out and back in.');
                        if (payload.method === 'personal_sign') {
                            console.log('[Particle Wallet Handler] personal_sign request via eoa-send');
                            const signResult = await eoaProvider.request({
                                method: 'personal_sign',
                                params: payload.params,
                            });
                            console.log('[Particle Wallet Handler] personal_sign result:', signResult?.substring(0, 20) + '...');
                            window.parent.postMessage({
                                type: 'particle-wallet.eoa-send-result',
                                requestId,
                                payload: { signature: signResult, txHash: signResult },
                            }, '*');
                            break;
                        }
                        const targetChainId = payload.chainId;
                        if (targetChainId) {
                            const chainIdHex = '0x' + targetChainId.toString(16);
                            try {
                                await eoaProvider.request({
                                    method: 'wallet_switchEthereumChain',
                                    params: [{ chainId: chainIdHex }],
                                });
                            }
                            catch (switchErr) {
                                console.log('[Particle Wallet Handler] Chain switch info:', switchErr?.message || switchErr);
                            }
                        }
                        const eoaTxParams = { ...payload.txParams, from: connectedEoaAddress };
                        console.log('[Particle Wallet Handler] EOA send on chain', targetChainId, ':', eoaTxParams);
                        const eoaTxHash = await eoaProvider.request({
                            method: 'eth_sendTransaction',
                            params: [eoaTxParams],
                        });
                        console.log('[Particle Wallet Handler] EOA tx sent:', eoaTxHash);
                        window.parent.postMessage({
                            type: 'particle-wallet.eoa-send-result',
                            requestId,
                            payload: { txHash: eoaTxHash },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.rpc': {
                        const { method: walletRpcMethod, params: walletRpcParams } = payload;
                        if (walletRpcMethod === 'eth_accounts' || walletRpcMethod === 'eth_requestAccounts') {
                            window.parent.postMessage({
                                type: 'particle-wallet.rpc-result',
                                requestId,
                                payload: { result: connectedEoaAddress ? [connectedEoaAddress] : [] },
                            }, '*');
                            break;
                        }
                        if (walletRpcMethod === 'eth_chainId') {
                            window.parent.postMessage({
                                type: 'particle-wallet.rpc-result',
                                requestId,
                                payload: { result: chainId ? '0x' + chainId.toString(16) : null },
                            }, '*');
                            break;
                        }
                        const walletProvider = await connector?.getProvider();
                        if (!walletProvider)
                            throw new Error('No provider available');
                        if (walletRpcMethod === 'eth_sendTransaction' && walletRpcParams?.[0]?.chainId) {
                            const targetChainHex = walletRpcParams[0].chainId;
                            try {
                                await walletProvider.request({
                                    method: 'wallet_switchEthereumChain',
                                    params: [{ chainId: targetChainHex }],
                                });
                            }
                            catch (switchErr) {
                                console.log('[Particle Wallet RPC] Chain switch info:', switchErr?.message || switchErr);
                            }
                            const { chainId: _removed, ...cleanParams } = walletRpcParams[0];
                            walletRpcParams[0] = cleanParams;
                        }
                        console.log('[Particle Wallet RPC] Calling provider.request:', walletRpcMethod);
                        const walletRpcResult = await walletProvider.request({ method: walletRpcMethod, params: walletRpcParams });
                        console.log('[Particle Wallet RPC] Result:', walletRpcMethod, typeof walletRpcResult === 'string' ? walletRpcResult.substring(0, 20) + '...' : walletRpcResult);
                        window.parent.postMessage({
                            type: 'particle-wallet.rpc-result',
                            requestId,
                            payload: { result: walletRpcResult },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.send': {
                        if (!smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart Account not yet initialized. Please wait for wallet to fully connect.');
                        }
                        const { to, amount, tokenAddress, chainId: targetChainId, decimals = 18 } = payload;
                        const isSolanaTransfer = targetChainId === 101;
                        console.log('[Particle Wallet Handler] Transfer request:', {
                            to,
                            amount,
                            tokenAddress,
                            targetChainId,
                            decimals,
                            isSolanaTransfer,
                        });
                        if (isSolanaTransfer && !smartAccountInfo?.solanaSmartAccountAddress) {
                            console.warn('[Particle Wallet Handler] Solana smart account not available');
                        }
                        const transferPayload = {
                            token: {
                                chainId: targetChainId || 8453,
                                address: tokenAddress || '0x0000000000000000000000000000000000000000',
                            },
                            amount: amount,
                            receiver: to,
                        };
                        console.log('[Particle Wallet Handler] Creating transfer transaction:', transferPayload);
                        console.log('[Particle Wallet Handler] Connected EOA:', connectedEoaAddress);
                        console.log('[Particle Wallet Handler] Smart Account (EVM):', smartAccountInfo?.smartAccountAddress);
                        console.log('[Particle Wallet Handler] Smart Account (Solana):', smartAccountInfo?.solanaSmartAccountAddress);
                        const transaction = await universalAccount.createTransferTransaction(transferPayload);
                        console.log('[Particle Wallet Handler] Transaction created:', transaction);
                        console.log('[Particle Wallet Handler] Transaction userOps:', transaction.userOps?.length);
                        let sendProvider = await connector?.getProvider();
                        if (!sendProvider) {
                            for (let attempt = 0; attempt < 3 && !sendProvider; attempt++) {
                                console.log('[Particle Wallet Handler] Send provider not ready, retrying...', attempt + 1);
                                await new Promise(r => setTimeout(r, 1500));
                                sendProvider = await connector?.getProvider();
                            }
                        }
                        if (!sendProvider) {
                            throw new Error('No wallet provider available — session may not be restored. Try logging out and back in.');
                        }
                        console.log('[Particle Wallet Handler] Signing rootHash:', transaction.rootHash, 'with address:', connectedEoaAddress);
                        const signature = await sendProvider.request({
                            method: 'personal_sign',
                            params: [transaction.rootHash, connectedEoaAddress],
                        });
                        console.log('[Particle Wallet Handler] Signature obtained:', signature?.substring(0, 20) + '...');
                        const result = await universalAccount.sendTransaction(transaction, signature);
                        console.log('[Particle Wallet Handler] Transaction sent:', result);
                        window.parent.postMessage({
                            type: 'particle-wallet.send-result',
                            requestId,
                            payload: {
                                success: true,
                                hash: result.transactionHash || result.hash || transaction.transactionId,
                                transactionId: transaction.transactionId,
                                result,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.create-transfer': {
                        if (!smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart Account not yet initialized. Please wait for wallet to fully connect.');
                        }
                        const { to, amount, tokenAddress, chainId: targetChainId, decimals = 18 } = payload;
                        const transferPayload = {
                            token: {
                                chainId: targetChainId || 8453,
                                address: tokenAddress || '0x0000000000000000000000000000000000000000',
                            },
                            amount: amount,
                            receiver: to,
                        };
                        console.log('[Particle Wallet Handler] create-transfer:', transferPayload);
                        const createdTx = await universalAccount.createTransferTransaction(transferPayload);
                        console.log('[Particle Wallet Handler] Transfer transaction created, rootHash:', createdTx.rootHash);
                        window.parent.postMessage({
                            type: 'particle-wallet.create-transfer-result',
                            requestId,
                            payload: {
                                rootHash: createdTx.rootHash,
                                transactionData: JSON.parse(JSON.stringify(createdTx)),
                                eoaAddress: connectedEoaAddress,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.submit-transfer': {
                        if (!universalAccount) {
                            throw new Error('Universal Account not available');
                        }
                        const { transactionData: txData, signature: sig } = payload;
                        console.log('[Particle Wallet Handler] submit-transfer: sig=', sig?.substring(0, 20) + '...');
                        const submitResult = await universalAccount.sendTransaction(txData, sig);
                        console.log('[Particle Wallet Handler] Transaction submitted:', submitResult);
                        window.parent.postMessage({
                            type: 'particle-wallet.send-result',
                            requestId,
                            payload: {
                                success: true,
                                hash: submitResult.transactionHash || submitResult.hash || txData.transactionId,
                                transactionId: txData.transactionId,
                                result: submitResult,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.estimate-fee': {
                        if (!smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart Account not yet initialized. Please wait for wallet to fully connect.');
                        }
                        const { to, amount, tokenAddress, chainId: targetChainId } = payload;
                        const isSolanaTransfer = targetChainId === 101;
                        const transferPayload = {
                            token: {
                                chainId: targetChainId || 8453,
                                address: tokenAddress || '0x0000000000000000000000000000000000000000',
                            },
                            amount: amount,
                            receiver: to,
                        };
                        console.log('[Particle Wallet Handler] Estimating fee for:', {
                            ...transferPayload,
                            isSolanaTransfer,
                        });
                        const transaction = await universalAccount.createTransferTransaction(transferPayload);
                        console.log('[Particle Wallet Handler] Transaction created for fee estimate:', transaction);
                        const fees = transaction.tokenChanges?.totalFeeInUSD || '0';
                        const freeGasFee = transaction.transactionFees?.freeGasFee || false;
                        const freeServiceFee = transaction.transactionFees?.freeServiceFee || false;
                        const solanaRent = transaction.tokenChanges?.solanaRentFee || transaction.fees?.totals?.solanaRentFee || null;
                        const solanaRentUSD = transaction.tokenChanges?.solanaRentFeeInUSD || transaction.fees?.totals?.solanaRentFeeInUSD || null;
                        console.log('[Particle Wallet Handler] Fee estimate:', {
                            fees,
                            freeGasFee,
                            freeServiceFee,
                            isSolanaTransfer,
                            solanaRent,
                            solanaRentUSD,
                        });
                        window.parent.postMessage({
                            type: 'particle-wallet.fee-estimate',
                            requestId,
                            payload: {
                                success: true,
                                feeEstimate: {
                                    total: fees,
                                    totalUSD: parseFloat(fees) || 0,
                                    gas: transaction.transactionFees?.transactionServiceFeeAmountInUSD || '0',
                                    gasUSD: parseFloat(transaction.transactionFees?.transactionServiceFeeAmountInUSD || '0'),
                                    service: transaction.transactionFees?.transactionLPFeeAmountInUSD || '0',
                                    serviceUSD: parseFloat(transaction.transactionFees?.transactionLPFeeAmountInUSD || '0'),
                                    lp: '0',
                                    lpUSD: 0,
                                    freeGasFee,
                                    freeServiceFee,
                                    solanaRent,
                                    solanaRentUSD,
                                    isSolanaTransfer,
                                },
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.estimate-swap': {
                        if (!smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart Account not yet initialized. Please wait for wallet to fully connect.');
                        }
                        const { fromToken: estFromToken, toToken: estToToken, fromAmount: estFromAmount, toChainId: estToChainId } = payload;
                        console.log('[Particle Wallet Handler] Estimating swap:', { estFromToken, estToToken, estFromAmount, estToChainId });
                        const estTokenTypeMap = {
                            'USDC': SUPPORTED_TOKEN_TYPE.USDC,
                            'USDT': SUPPORTED_TOKEN_TYPE.USDT,
                            'ETH': SUPPORTED_TOKEN_TYPE.ETH,
                            'BTC': SUPPORTED_TOKEN_TYPE.BTC,
                            'SOL': SUPPORTED_TOKEN_TYPE.SOL,
                            'BNB': SUPPORTED_TOKEN_TYPE.BNB,
                        };
                        const estTokenDecimals = {
                            'USDC': 6, 'USDT': 6, 'ETH': 18, 'BTC': 8, 'SOL': 9, 'BNB': 18,
                        };
                        const estToTokenType = estTokenTypeMap[estToToken?.toUpperCase()];
                        if (!estToTokenType) {
                            throw new Error(`Unsupported target token: ${estToToken}`);
                        }
                        const estAssets = await universalAccount.getPrimaryAssets();
                        const estFromAsset = estAssets.assets.find((a) => a.tokenType?.toUpperCase() === estFromToken?.toUpperCase());
                        const estToAsset = estAssets.assets.find((a) => a.tokenType?.toUpperCase() === estToToken?.toUpperCase());
                        const estFromPrice = estFromAsset?.price || 1;
                        const estToPrice = estToAsset?.price || 1;
                        if (estToPrice <= 0) {
                            throw new Error(`Price not available for ${estToToken}`);
                        }
                        const estFromAmountFloat = parseFloat(estFromAmount);
                        const estFromAmountUSD = estFromAmountFloat * estFromPrice;
                        const estExpectedOutput = estFromAmountUSD / estToPrice;
                        const estToTokenDecimals = estTokenDecimals[estToToken?.toUpperCase()] || 18;
                        const estExpectedOutputString = estExpectedOutput.toFixed(estToTokenDecimals);
                        const estTransaction = await universalAccount.createConvertTransaction({
                            expectToken: {
                                type: estToTokenType,
                                amount: estExpectedOutputString,
                            },
                            chainId: estToChainId || 8453,
                        });
                        console.log('[Particle Wallet Handler] Estimation transaction created:', estTransaction);
                        let actualReceiveAmount = estExpectedOutputString;
                        if (estTransaction.lendingTokens && estTransaction.lendingTokens.length > 0) {
                            const lendingToken = estTransaction.lendingTokens[0];
                            const rawAmount = lendingToken.amount || '0';
                            actualReceiveAmount = (Number(BigInt(rawAmount)) / 1e18).toFixed(estToTokenDecimals);
                            console.log('[Particle Wallet Handler] Actual receive amount from lendingTokens:', actualReceiveAmount);
                        }
                        let feesData = null;
                        if (estTransaction.feeQuotes?.[0]) {
                            const totals = estTransaction.feeQuotes[0].fees?.totals || {};
                            feesData = {
                                totalFeeUSD: totals.feeTokenAmountInUSD
                                    ? (Number(BigInt(totals.feeTokenAmountInUSD)) / 1e18).toFixed(4)
                                    : '0',
                                gasFeeUSD: totals.gasFeeTokenAmountInUSD
                                    ? (Number(BigInt(totals.gasFeeTokenAmountInUSD)) / 1e18).toFixed(4)
                                    : '0',
                                serviceFeeUSD: totals.transactionServiceFeeTokenAmountInUSD
                                    ? (Number(BigInt(totals.transactionServiceFeeTokenAmountInUSD)) / 1e18).toFixed(4)
                                    : '0',
                                freeGasFee: estTransaction.feeQuotes[0].fees?.freeGasFee || false,
                                freeServiceFee: estTransaction.feeQuotes[0].fees?.freeServiceFee || false,
                            };
                        }
                        const tokenChangesFee = estTransaction.tokenChanges?.totalFeeInUSD || '0';
                        window.parent.postMessage({
                            type: 'particle-wallet.estimate-swap-result',
                            requestId,
                            payload: {
                                success: true,
                                fromToken: estFromToken,
                                toToken: estToToken,
                                fromAmount: estFromAmount,
                                fromAmountUSD: estFromAmountUSD.toFixed(2),
                                expectedOutput: actualReceiveAmount,
                                toChainId: estToChainId || 8453,
                                fees: feesData,
                                tokenChangesFeeUSD: tokenChangesFee,
                            },
                        }, '*');
                        break;
                    }
                    case 'particle-wallet.swap': {
                        if (!smartAccountInfo?.smartAccountAddress) {
                            throw new Error('Smart Account not yet initialized. Please wait for wallet to fully connect.');
                        }
                        const { fromToken, toToken, fromAmount, toChainId } = payload;
                        console.log('[Particle Wallet Handler] Swap request:', {
                            fromToken,
                            toToken,
                            fromAmount,
                            toChainId,
                        });
                        const tokenTypeMap = {
                            'USDC': SUPPORTED_TOKEN_TYPE.USDC,
                            'USDT': SUPPORTED_TOKEN_TYPE.USDT,
                            'ETH': SUPPORTED_TOKEN_TYPE.ETH,
                            'BTC': SUPPORTED_TOKEN_TYPE.BTC,
                            'SOL': SUPPORTED_TOKEN_TYPE.SOL,
                            'BNB': SUPPORTED_TOKEN_TYPE.BNB,
                        };
                        const tokenDecimals = {
                            'USDC': 6,
                            'USDT': 6,
                            'ETH': 18,
                            'BTC': 8,
                            'SOL': 9,
                            'BNB': 18,
                        };
                        const toTokenType = tokenTypeMap[toToken?.toUpperCase()];
                        if (!toTokenType) {
                            throw new Error(`Unsupported target token: ${toToken}. Primary assets only: USDC, USDT, ETH, BTC, SOL, BNB`);
                        }
                        console.log('[Particle Wallet Handler] Fetching prices for swap calculation...');
                        const assets = await universalAccount.getPrimaryAssets();
                        const fromAsset = assets.assets.find((a) => a.tokenType?.toUpperCase() === fromToken?.toUpperCase());
                        const toAsset = assets.assets.find((a) => a.tokenType?.toUpperCase() === toToken?.toUpperCase());
                        const fromPrice = fromAsset?.price || 1;
                        const toPrice = toAsset?.price || 1;
                        if (!toPrice || toPrice <= 0) {
                            throw new Error(`Price data not available for ${toToken}`);
                        }
                        const fromAmountFloat = parseFloat(fromAmount);
                        const fromAmountUSD = fromAmountFloat * fromPrice;
                        const expectedOutput = fromAmountUSD / toPrice;
                        const toTokenDecimals = tokenDecimals[toToken?.toUpperCase()] || 18;
                        const expectedOutputString = expectedOutput.toFixed(toTokenDecimals);
                        console.log('[Particle Wallet Handler] Swap calculation:', {
                            fromAmount,
                            fromPrice,
                            fromAmountUSD,
                            toPrice,
                            expectedOutput,
                            expectedOutputString,
                        });
                        const swapTransaction = await universalAccount.createConvertTransaction({
                            expectToken: {
                                type: toTokenType,
                                amount: expectedOutputString,
                            },
                            chainId: toChainId || 8453,
                        });
                        console.log('[Particle Wallet Handler] Convert transaction created:', swapTransaction);
                        const swapProvider = await connector?.getProvider();
                        if (!swapProvider) {
                            throw new Error('No wallet provider available');
                        }
                        console.log('[Particle Wallet Handler] Signing swap rootHash with address:', connectedEoaAddress);
                        const swapSignature = await swapProvider.request({
                            method: 'personal_sign',
                            params: [swapTransaction.rootHash, connectedEoaAddress],
                        });
                        console.log('[Particle Wallet Handler] Swap signature obtained');
                        const swapResult = await universalAccount.sendTransaction(swapTransaction, swapSignature);
                        console.log('[Particle Wallet Handler] Swap sent:', swapResult);
                        const swapFees = swapTransaction.tokenChanges?.totalFeeInUSD || '0';
                        window.parent.postMessage({
                            type: 'particle-wallet.swap-result',
                            requestId,
                            payload: {
                                success: true,
                                transactionId: swapResult.transactionId || swapTransaction.transactionId,
                                fromToken,
                                toToken,
                                fromAmount,
                                expectedOutput: expectedOutputString,
                                toChainId: toChainId || 8453,
                                feeUSD: swapFees,
                            },
                        }, '*');
                        break;
                    }
                }
            }
            catch (error) {
                console.error('[Particle Wallet Handler]:', error);
                window.parent.postMessage({
                    type: 'particle-wallet.error',
                    requestId,
                    payload: { message: error.message || 'Unknown error' },
                }, '*');
            }
        };
        window.addEventListener('message', handleWalletDataRequest);
        return () => {
            window.removeEventListener('message', handleWalletDataRequest);
        };
    }, [active, universalAccount, connector, connectedEoaAddress, smartAccountInfo, chainId, eoaAddress]);
    React.useEffect(() => {
        if (!active || !smartAccountInfo?.smartAccountAddress)
            return;
        console.log('[Particle Auth]: Smart Account loaded, notifying parent:', smartAccountInfo.smartAccountAddress);
        window.parent.postMessage({
            type: 'particle-wallet.ready',
            payload: {
                ready: true,
                address: eoaAddress,
                smartAccountAddress: smartAccountInfo.smartAccountAddress,
                solanaSmartAccountAddress: smartAccountInfo.solanaSmartAccountAddress,
            },
        }, '*');
    }, [active, smartAccountInfo, eoaAddress]);
    const account = smartAccountInfo?.smartAccountAddress || eoaAddress;
    return (<ParticleNetworkContext.Provider value={{
            ...(isAddress(eoaAddress) && {
                chainId,
                account,
                eoaAddress,
                library,
                active,
                connector,
                smartAccountInfo,
                universalAccount: universalAccount || undefined,
                primaryAssets,
                refreshPrimaryAssets: fetchPrimaryAssets,
            }),
            deactivate,
        }}>
      {children}
    </ParticleNetworkContext.Provider>);
});
ParticleNetworkProvider.displayName = 'ParticleNetworkProviderInner';
export default ParticleNetworkProvider;
//# sourceMappingURL=ParticleNetworkContext.js.map