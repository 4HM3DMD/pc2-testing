/**
 * PC2 IPFS Relay
 *
 * Lightweight libp2p node providing:
 * - Circuit Relay Server (NAT traversal for PC2 nodes)
 * - Kademlia DHT Server (content discovery for the CDN network)
 * - AutoNAT (helps clients detect their NAT status)
 * - DCUtR (direct connection upgrade through relay)
 *
 * Designed to run alongside existing Boson/WireGuard services on PC2 supernodes.
 */

// Polyfill Promise.withResolvers for Node.js 20 (added natively in Node 22)
if (typeof Promise.withResolvers === 'undefined') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || './data';
const TCP_PORT = parseInt(process.env.TCP_PORT || '4003', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '4004', 10);
const PUBLIC_IP = process.env.PUBLIC_IP || '69.164.241.210';
const KEY_FILE = join(DATA_DIR, 'peer-key.bin');
const STATS_INTERVAL_MS = 60_000;

const BOOTSTRAP_NODES = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [PC2 IPFS Relay] ${msg}`);
}

async function loadOrCreateKey() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  if (existsSync(KEY_FILE)) {
    log('Loading existing peer key...');
    const raw = readFileSync(KEY_FILE);
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    return privateKeyFromProtobuf(new Uint8Array(raw));
  }

  log('Generating new Ed25519 peer key...');
  const key = await generateKeyPair('Ed25519');
  const { privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const encoded = privateKeyToProtobuf(key);
  writeFileSync(KEY_FILE, Buffer.from(encoded));
  return key;
}

async function main() {
  const privateKey = await loadOrCreateKey();

  const node = await createLibp2p({
    privateKey,
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${TCP_PORT}`,
        `/ip4/0.0.0.0/tcp/${WS_PORT}/ws`,
      ],
      announce: [
        `/ip4/${PUBLIC_IP}/tcp/${TCP_PORT}`,
        `/ip4/${PUBLIC_IP}/tcp/${WS_PORT}/ws`,
      ],
    },
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({ list: BOOTSTRAP_NODES }),
    ],
    services: {
      identify: identify(),
      // DHT defaults are already bounded (kBucketSize=20, prefixLength=6 → max
      // 1280 routing-table entries). Made explicit for documentation only.
      dht: kadDHT({
        clientMode: false,
        kBucketSize: 20,
        prefixLength: 6,
      }),
      // circuit-relay-v2 defaults are already conservative (maxReservations=15,
      // reservationTtl=2h, maxOutboundStopStreams=300). The HOP stream caps,
      // however, fall back to the libp2p registrar default (32) when undefined,
      // which is a soft limit — set them explicitly so tightening is local
      // to this file rather than inherited.
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 32,
          reservationTtl: 30 * 60 * 1000, // 30 min (default 2h)
          applyDefaultLimit: true,
        },
        maxInboundHopStreams: 64,
        maxOutboundHopStreams: 64,
        maxOutboundStopStreams: 128,
      }),
      dcutr: dcutr(),
      autoNAT: autoNAT(),
      ping: ping(),
    },
    connectionManager: {
      // Lowered from 512: each accepted connection holds yamux + noise +
      // identify state (~10–20 MB). At 512 the host accumulates 5–10 GB of
      // per-connection state at peak. 256 halves the steady-state memory
      // footprint and gives the connection manager room to prune cleanly
      // before saturation. Default is 300 — we stay above default to keep
      // serving ample PC2 traffic.
      maxConnections: 256,
      // minConnections is not a valid option in libp2p@3.1.5 (was silently
      // ignored). Removed.
    },
  });

  await node.start();

  log('Started successfully');
  log(`Peer ID: ${node.peerId.toString()}`);
  log('Listening on:');
  for (const ma of node.getMultiaddrs()) {
    log(`  ${ma.toString()}`);
  }

  setInterval(() => {
    const peers = node.getPeers();
    log(`Connected peers: ${peers.length}`);
  }, STATS_INTERVAL_MS);

  const shutdown = async () => {
    log('Shutting down...');
    await node.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
