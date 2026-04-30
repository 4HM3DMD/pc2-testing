import React, { useRef, useMemo, useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { NODE_COLORS, NODE_SIZES } from "./consts";

const pointVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aOnline;
  varying float  vOnline;
  varying vec3   vColor;
  uniform float  uTime;
  uniform float  uPixelRatio;

  void main() {
    vColor  = color;
    vOnline = aOnline;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    float phase = position.x * 3.0 + position.y * 5.0 + position.z * 7.0;
    float pulse = 1.0 + 0.08 * sin(uTime * 1.2 + phase)
                      + aOnline * 0.06 * sin(uTime * 2.5 + phase * 0.7);
    gl_PointSize = aSize * uPixelRatio * pulse * (30.0 / -mvPos.z);
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const pointFragmentShader = /* glsl */ `
  varying float vOnline;
  varying vec3  vColor;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.4) discard;

    float core = 1.0 - smoothstep(0.0, 0.12, d);
    float mid  = 1.0 - smoothstep(0.12, 0.25, d);
    float rim  = 1.0 - smoothstep(0.25, 0.4, d);
    float midMul = mix(0.04, 0.35, vOnline);
    float rimMul = mix(0.01, 0.08, vOnline);
    float shape = core + mid * midMul + rim * rimMul;

    float alpha = shape * mix(0.4, 1.0, vOnline);
    gl_FragColor = vec4(vColor * (1.0 + core * 0.3 * mix(0.5, 1.0, vOnline)), alpha);
  }
`;

const colorCache = new Map();
function getColor(hex) {
  if (!colorCache.has(hex)) colorCache.set(hex, new THREE.Color(hex));
  return colorCache.get(hex);
}

function nodeColor(node) {
  if (node.nodeType === "supernode") return getColor(NODE_COLORS.supernode);
  if (node.status === "online") return getColor(NODE_COLORS.online);
  return getColor(NODE_COLORS.offline);
}

function nodeSize(node) {
  if (node.nodeType === "supernode") return NODE_SIZES.supernode;
  if (node.status === "online") return NODE_SIZES.online;
  return NODE_SIZES.offline;
}

export function NodePoints({ nodes }) {
  const pointsRef = useRef(null);
  const materialRef = useRef(null);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: pointVertexShader,
        fragmentShader: pointFragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        },
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
      }),
    []
  );

  useEffect(() => {
    materialRef.current = material;
  }, [material]);

  const geometry = useMemo(() => {
    const count = nodes.length || 1;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const online = new Float32Array(count);

    nodes.forEach((node, i) => {
      positions[i * 3] = node.position[0];
      positions[i * 3 + 1] = node.position[1];
      positions[i * 3 + 2] = node.position[2];

      const c = nodeColor(node);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      sizes[i] = nodeSize(node);
      online[i] = node.status === "online" ? 1.0 : 0.0;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("aOnline", new THREE.BufferAttribute(online, 1));
    return geo;
  }, [nodes]);

  useEffect(() => {
    if (!pointsRef.current) return;
    const geo = pointsRef.current.geometry;
    const posAttr = geo.getAttribute("position");
    const colAttr = geo.getAttribute("color");
    const sizeAttr = geo.getAttribute("aSize");
    const onlineAttr = geo.getAttribute("aOnline");

    if (posAttr.count !== nodes.length) return;

    nodes.forEach((node, i) => {
      posAttr.setXYZ(i, node.position[0], node.position[1], node.position[2]);

      const c = nodeColor(node);
      colAttr.setXYZ(i, c.r, c.g, c.b);

      sizeAttr.setX(i, nodeSize(node));
      onlineAttr.setX(i, node.status === "online" ? 1.0 : 0.0);
    });

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    onlineAttr.needsUpdate = true;
  }, [nodes]);

  useFrame((state) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    }
  });

  if (nodes.length === 0) return null;

  return (
    <points ref={pointsRef} geometry={geometry}>
      <primitive object={material} attach="material" />
    </points>
  );
}
