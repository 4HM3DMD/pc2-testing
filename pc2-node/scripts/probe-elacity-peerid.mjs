#!/usr/bin/env node
/**
 * One-off probe: dial /ip4/34.77.31.164/tcp/4001 with a deliberately wrong
 * PeerID. libp2p's handshake validator typically throws an error of the form
 * "peer id mismatch, expected <X> but got <Y>", exposing the real PeerID (Y).
 *
 * Run from pc2-node dir: node scripts/probe-elacity-peerid.mjs
 */
import '../dist/utils/polyfill.js';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';

const TARGETS = [
  '/ip4/34.77.31.164/tcp/4001/p2p/12D3KooWNieM3HRBJdVqaQucZEJdqA3oWKrKf3Gx3hp2cmtR9GNK',
  '/dns4/ipfs.ela.city/tcp/4001/p2p/12D3KooWNieM3HRBJdVqaQucZEJdqA3oWKrKf3Gx3hp2cmtR9GNK',
];

const node = await createLibp2p({
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() },
});

await node.start();
console.log('[probe] local peer id:', node.peerId.toString());

for (const target of TARGETS) {
  console.log('\n[probe] dialing:', target);
  try {
    const conn = await node.dial(multiaddr(target), {
      signal: AbortSignal.timeout(10_000),
    });
    console.log('[probe] SUCCESS — connected, remote peer id:', conn.remotePeer.toString());
  } catch (err) {
    console.log('[probe] dial failed:', err?.message || err);
    if (err?.name) console.log('[probe]   name:', err.name);
    if (err?.cause) console.log('[probe]   cause:', String(err.cause?.message || err.cause));
    const deepMsg = JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 800);
    console.log('[probe]   deep:', deepMsg);
  }
}

await node.stop();
process.exit(0);
