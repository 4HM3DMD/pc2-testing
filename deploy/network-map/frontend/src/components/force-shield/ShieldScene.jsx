import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { ForceShield } from "./ForceShield";
import { NodePoints } from "./NodePoints";
import { NodeConnections } from "./NodeConnections";
import { useNetworkNodes } from "./useNetworkNodes";

const overlayWrapStyle = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  zIndex: 10,
  userSelect: "none",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: "8px",
  padding: "0 8px 12px",
};

const overlayPillStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  borderRadius: "9999px",
  background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(4px)",
  padding: "6px 14px",
  fontSize: "12px",
  color: "rgba(255,255,255,0.8)",
  fontFamily: "Inter, system-ui, sans-serif",
  whiteSpace: "nowrap",
};

const pulseDotStyle = {
  display: "inline-block",
  height: "6px",
  width: "6px",
  borderRadius: "50%",
  backgroundColor: "#2dd4bf",
  animation: "pulse 2s ease-in-out infinite",
};

function StatsOverlay({ stats, supernodeCount }) {
  if (!stats) return null;
  return (
    <div style={overlayWrapStyle}>
      <div style={overlayPillStyle}>
        <span style={pulseDotStyle} />
        <span>
          <strong style={{ color: "#2dd4bf" }}>{stats.onlineNow}</strong>{" "}
          online
        </span>
        <span style={{ color: "rgba(255,255,255,0.3)" }}>|</span>
        <span>
          <strong style={{ color: "#e2c478" }}>{supernodeCount}</strong>{" "}
          <span style={{ color: "#e2c478" }}>supernodes</span>
        </span>
        <span style={{ color: "rgba(255,255,255,0.3)" }}>|</span>
        <span>{stats.totalNodes} nodes</span>
      </div>
    </div>
  );
}

export function ShieldScene() {
  const { nodes, stats } = useNetworkNodes();
  const supernodeCount = React.useMemo(
    () => nodes.filter((n) => n.nodeType === "supernode").length,
    [nodes]
  );

  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
      <StatsOverlay stats={stats} supernodeCount={supernodeCount} />
      <Canvas
        camera={{ position: [0, 0, 4.5], fov: 50 }}
        gl={{ alpha: true, antialias: true }}
        dpr={[1, 2]}
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <color attach="background" args={["#0a0a0a"]} />
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 5, 5]} intensity={1.2} />
        <directionalLight position={[-3, 2, 2]} intensity={0.5} />
        <ForceShield isActive />
        <NodeConnections nodes={nodes} />
        <NodePoints nodes={nodes} />
        <OrbitControls
          enableZoom={false}
          enablePan={false}
          autoRotate
          autoRotateSpeed={0.6}
          maxPolarAngle={Math.PI / 2}
          minPolarAngle={Math.PI / 2 - 0.3}
        />
      </Canvas>
    </div>
  );
}
