import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  CONNECTION_COLORS,
  CONNECTION_MAX_ANGLE,
  MAX_CONNECTIONS_PER_NODE,
  SIGNAL_COUNT,
  SIGNAL_SPEED,
  ARC_INWARD_FACTOR,
} from "./consts";

const lineVertexShader = /* glsl */ `
  attribute vec3  aColor;
  attribute float aBrightness;
  varying vec3  vColor;
  varying float vBrightness;

  void main() {
    vColor      = aColor;
    vBrightness = aBrightness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const lineFragmentShader = /* glsl */ `
  varying vec3  vColor;
  varying float vBrightness;

  void main() {
    float whiten = smoothstep(0.35, 1.0, vBrightness) * 0.45;
    vec3 color = mix(vColor, vec3(1.0), whiten);
    gl_FragColor = vec4(color, vBrightness);
  }
`;

function isLive(node) {
  return node.status === "online" || node.nodeType === "supernode";
}

const _colorCache = new Map();
function cachedColor(hex) {
  if (!_colorCache.has(hex)) _colorCache.set(hex, new THREE.Color(hex));
  return _colorCache.get(hex);
}

function connectionColor(type) {
  switch (type) {
    case "backbone": return cachedColor(CONNECTION_COLORS.supernodeBackbone);
    case "hub": return cachedColor(CONNECTION_COLORS.supernodeToNode);
    case "live": return cachedColor(CONNECTION_COLORS.liveToLive);
    case "dormant": return cachedColor(CONNECTION_COLORS.dormant);
  }
}

function connectionBaseOpacity(type) {
  switch (type) {
    case "backbone": return 0.14;
    case "hub": return 0.10;
    case "live": return 0.07;
    case "dormant": return 0.04;
  }
}

function connectionSignalSpeed(type) {
  switch (type) {
    case "backbone": return SIGNAL_SPEED * 1.4;
    case "hub": return SIGNAL_SPEED * 1.1;
    case "live": return SIGNAL_SPEED;
    case "dormant": return SIGNAL_SPEED * 0.5;
  }
}

function connectionSignalPeak(type) {
  switch (type) {
    case "backbone": return 0.95;
    case "hub": return 0.80;
    case "live": return 0.65;
    case "dormant": return 0.30;
  }
}

function classifyConnection(nodes, i, j) {
  const iSuper = nodes[i].nodeType === "supernode";
  const jSuper = nodes[j].nodeType === "supernode";
  if (iSuper && jSuper) return "backbone";
  if (iSuper || jSuper) {
    return isLive(nodes[i]) && isLive(nodes[j]) ? "hub" : "dormant";
  }
  return isLive(nodes[i]) && isLive(nodes[j]) ? "live" : "dormant";
}

function buildConnections(nodes) {
  const connections = [];
  const added = new Set();
  const counts = new Uint8Array(nodes.length);

  const supernodeIndices = nodes
    .map((n, i) => (n.nodeType === "supernode" ? i : -1))
    .filter((i) => i >= 0);

  function addConn(i, j) {
    const key = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (added.has(key)) return;
    added.add(key);
    connections.push({
      from: Math.min(i, j),
      to: Math.max(i, j),
      connType: classifyConnection(nodes, i, j),
    });
    counts[i]++;
    counts[j]++;
  }

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === "supernode") continue;
    const pi = new THREE.Vector3(...nodes[i].position).normalize();
    let bestIdx = -1;
    let bestAngle = Infinity;
    for (const si of supernodeIndices) {
      const ps = new THREE.Vector3(...nodes[si].position).normalize();
      const angle = Math.acos(Math.min(1, pi.dot(ps)));
      if (angle < bestAngle) {
        bestAngle = angle;
        bestIdx = si;
      }
    }
    if (bestIdx >= 0) addConn(i, bestIdx);
  }

  for (let a = 0; a < supernodeIndices.length; a++) {
    for (let b = a + 1; b < supernodeIndices.length; b++) {
      addConn(supernodeIndices[a], supernodeIndices[b]);
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const isSupernode = nodes[i].nodeType === "supernode";
    const maxForNode = isSupernode ? 999 : MAX_CONNECTIONS_PER_NODE;
    if (counts[i] >= maxForNode) continue;

    const pi = new THREE.Vector3(...nodes[i].position).normalize();
    const candidates = [];

    for (let j = i + 1; j < nodes.length; j++) {
      const jIsSupernode = nodes[j].nodeType === "supernode";
      if (!jIsSupernode && counts[j] >= MAX_CONNECTIONS_PER_NODE) continue;
      const pj = new THREE.Vector3(...nodes[j].position).normalize();
      const angle = Math.acos(Math.min(1, pi.dot(pj)));
      if (angle < CONNECTION_MAX_ANGLE) {
        candidates.push({ idx: j, angle });
      }
    }

    candidates.sort((a, b) => a.angle - b.angle);
    const take = Math.min(candidates.length, maxForNode - counts[i]);
    for (let k = 0; k < take; k++) {
      addConn(i, candidates[k].idx);
    }
  }

  return connections;
}

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _ctrl = new THREE.Vector3();

function arcPoint(a, b, t, out) {
  _va.set(a[0], a[1], a[2]);
  _vb.set(b[0], b[1], b[2]);
  _mid.lerpVectors(_va, _vb, 0.5);
  _ctrl.copy(_mid).multiplyScalar(ARC_INWARD_FACTOR);

  const it = 1 - t;
  out.x = it * it * _va.x + 2 * it * t * _ctrl.x + t * t * _vb.x;
  out.y = it * it * _va.y + 2 * it * t * _ctrl.y + t * t * _vb.y;
  out.z = it * it * _va.z + 2 * it * t * _ctrl.z + t * t * _vb.z;
}

const SEGS = 32;
const TAIL_LENGTH = 0.35;
const HEAD_LENGTH = 0.03;

function signalBrightness(headT, vertexT, tail, peak) {
  const d = headT - vertexT;
  if (d < -HEAD_LENGTH) return 0;
  if (d < 0) {
    const t = -d / HEAD_LENGTH;
    return peak * (1 - t * t);
  }
  if (d > tail) return 0;
  const t = d / tail;
  const fade = 1 - t;
  return peak * fade * fade * fade;
}

export function NodeConnections({ nodes }) {
  const linesRef = useRef(null);

  const connections = useMemo(() => {
    if (nodes.length < 2) return [];
    return buildConnections(nodes);
  }, [nodes]);

  const baseOpacities = useMemo(
    () => connections.map((c) => connectionBaseOpacity(c.connType)),
    [connections]
  );

  const lineGeo = useMemo(() => {
    const count = connections.length;
    if (count === 0) return null;

    const vertCount = count * SEGS * 2;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const brightness = new Float32Array(vertCount);
    const pt = { x: 0, y: 0, z: 0 };

    connections.forEach((conn, ci) => {
      const a = nodes[conn.from].position;
      const b = nodes[conn.to].position;
      const base = baseOpacities[ci];
      const col = connectionColor(conn.connType);

      for (let s = 0; s < SEGS; s++) {
        const t0 = s / SEGS;
        const t1 = (s + 1) / SEGS;
        const vi = (ci * SEGS + s) * 2;

        arcPoint(a, b, t0, pt);
        positions[vi * 3] = pt.x;
        positions[vi * 3 + 1] = pt.y;
        positions[vi * 3 + 2] = pt.z;

        arcPoint(a, b, t1, pt);
        positions[(vi + 1) * 3] = pt.x;
        positions[(vi + 1) * 3 + 1] = pt.y;
        positions[(vi + 1) * 3 + 2] = pt.z;

        colors[vi * 3] = col.r;
        colors[vi * 3 + 1] = col.g;
        colors[vi * 3 + 2] = col.b;
        colors[(vi + 1) * 3] = col.r;
        colors[(vi + 1) * 3 + 1] = col.g;
        colors[(vi + 1) * 3 + 2] = col.b;

        brightness[vi] = base;
        brightness[vi + 1] = base;
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aBrightness", new THREE.BufferAttribute(brightness, 1));
    return geo;
  }, [connections, nodes, baseOpacities]);

  const lineMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: lineVertexShader,
        fragmentShader: lineFragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );

  const signalState = useRef([]);

  useMemo(() => {
    if (connections.length === 0) {
      signalState.current = [];
      return;
    }
    const count = Math.min(SIGNAL_COUNT, connections.length * 3);
    signalState.current = Array.from({ length: count }, (_, i) => {
      const ci = i % connections.length;
      const baseSpeed = connectionSignalSpeed(connections[ci].connType);
      const peak = connectionSignalPeak(connections[ci].connType);
      return {
        connIdx: ci,
        progress: Math.random() * 1.4 - 0.2,
        speed: baseSpeed * (0.7 + Math.random() * 0.6),
        peak,
      };
    });
  }, [connections]);

  useFrame((_, delta) => {
    if (!linesRef.current || connections.length === 0) return;

    const brAttr = linesRef.current.geometry.getAttribute("aBrightness");
    const arr = brAttr.array;

    for (let ci = 0; ci < connections.length; ci++) {
      const base = baseOpacities[ci];
      for (let s = 0; s < SEGS; s++) {
        const vi = (ci * SEGS + s) * 2;
        arr[vi] = base;
        arr[vi + 1] = base;
      }
    }

    const signals = signalState.current;
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      sig.progress += delta * sig.speed;

      if (sig.progress >= 1.0 + TAIL_LENGTH) {
        sig.progress = -0.08;
        const newCi = Math.floor(Math.random() * connections.length);
        sig.connIdx = newCi;
        const baseSpeed = connectionSignalSpeed(connections[newCi].connType);
        sig.speed = baseSpeed * (0.7 + Math.random() * 0.6);
        sig.peak = connectionSignalPeak(connections[newCi].connType);
      }

      const ci = sig.connIdx;
      if (ci >= connections.length) continue;

      const headT = sig.progress;
      const tailEnd = headT - TAIL_LENGTH;

      const segMin = Math.max(0, Math.floor(tailEnd * SEGS) - 1);
      const segMax = Math.min(SEGS - 1, Math.ceil(headT * SEGS) + 1);

      for (let s = segMin; s <= segMax; s++) {
        const t0 = s / SEGS;
        const t1 = (s + 1) / SEGS;
        const vi = (ci * SEGS + s) * 2;

        const b0 = signalBrightness(headT, t0, TAIL_LENGTH, sig.peak);
        const b1 = signalBrightness(headT, t1, TAIL_LENGTH, sig.peak);

        arr[vi] = Math.min(1, arr[vi] + b0);
        arr[vi + 1] = Math.min(1, arr[vi + 1] + b1);
      }
    }

    brAttr.needsUpdate = true;
  });

  if (nodes.length < 2 || connections.length === 0 || !lineGeo) return null;

  return (
    <lineSegments ref={linesRef} geometry={lineGeo}>
      <primitive object={lineMaterial} attach="material" />
    </lineSegments>
  );
}
