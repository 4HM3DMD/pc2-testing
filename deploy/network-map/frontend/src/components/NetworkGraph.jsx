import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const LINK_TYPE = {
  BACKBONE: 'backbone',
  NODE_TO_SUPER: 'node-super',
  PEER: 'peer',
  OFFLINE: 'offline',
};

// Core hubs: InterServer + Contabo (full transport stack: WG, AWG, VLESS)
const CORE_SUPERNODES = new Set(['supernode_J1h7RHv5', 'supernode_EbfCHQUf']);

const COLORS = {
  supernodeCore: '#F0B90B',
  supernodeDim: '#a07a08',
  carrierNode: '#d4a50a',
  online: '#22c55e',
  offline: '#f59e0b',
  peer: '#38bdf8',
  gridDot: 'rgba(255,255,255,0.025)',
};

function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function NetworkGraph({ nodes }) {
  const graphRef = useRef();
  const containerRef = useRef();
  const animFrameRef = useRef();
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  useEffect(() => {
    if (graphRef.current && nodes.length > 0) {
      setTimeout(() => {
        graphRef.current.zoomToFit(600, 60);
      }, 800);
    }
  }, [nodes.length]);

  // Continuous repaint for time-based animations
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      if (graphRef.current) {
        graphRef.current.refresh();
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // Build decentralized graph topology
  const graphData = useMemo(() => {
    const graphNodes = nodes.map((node, i) => ({
      id: node.nodeIdentifier,
      status: node.status,
      activityType: node.activityType,
      nodeType: node.nodeType || 'registered',
      isCore: CORE_SUPERNODES.has(node.nodeIdentifier),
      x: (seededRandom(i * 137 + 1) - 0.5) * 900,
      y: (seededRandom(i * 137 + 2) - 0.5) * 700,
    }));

    const links = [];
    const supernodes = graphNodes.filter(n => n.nodeType === 'supernode');
    const onlineNodes = graphNodes.filter(n => n.nodeType !== 'supernode' && n.status === 'online');
    const offlineNodes = graphNodes.filter(n => n.nodeType !== 'supernode' && n.status !== 'online');

    // Full mesh between all supernodes (backbone)
    for (let i = 0; i < supernodes.length; i++) {
      for (let j = i + 1; j < supernodes.length; j++) {
        links.push({
          source: supernodes[i].id,
          target: supernodes[j].id,
          linkType: LINK_TYPE.BACKBONE,
        });
      }
    }

    // Distribute online nodes across supernodes (round-robin)
    if (supernodes.length > 0) {
      onlineNodes.forEach((node, idx) => {
        const assignedSuper = supernodes[idx % supernodes.length];
        links.push({
          source: assignedSuper.id,
          target: node.id,
          linkType: LINK_TYPE.NODE_TO_SUPER,
        });
      });
    }

    // Peer-to-peer links between ~30% of online nodes
    if (onlineNodes.length > 2) {
      const peerCount = Math.max(2, Math.floor(onlineNodes.length * 0.3));
      for (let i = 0; i < peerCount; i++) {
        const aIdx = Math.floor(seededRandom(i * 31 + 100) * onlineNodes.length);
        const bIdx = Math.floor(seededRandom(i * 31 + 200) * onlineNodes.length);
        if (aIdx !== bIdx) {
          links.push({
            source: onlineNodes[aIdx].id,
            target: onlineNodes[bIdx].id,
            linkType: LINK_TYPE.PEER,
          });
        }
      }
    }

    // Offline nodes get one faint link to nearest supernode
    if (supernodes.length > 0) {
      offlineNodes.forEach((node, idx) => {
        const assignedSuper = supernodes[idx % supernodes.length];
        links.push({
          source: assignedSuper.id,
          target: node.id,
          linkType: LINK_TYPE.OFFLINE,
        });
      });
    }

    return { nodes: graphNodes, links };
  }, [nodes]);

  // Configure d3 forces after graph mounts
  const handleEngineInit = useCallback(() => {
    const fg = graphRef.current;
    if (!fg) return;

    fg.d3Force('charge').strength((node) => {
      if (node.nodeType === 'supernode' && node.isCore) return -500;
      if (node.nodeType === 'supernode') return -250;
      if (node.status === 'online') return -120;
      return -40;
    });

    fg.d3Force('link')
      .distance((link) => {
        switch (link.linkType) {
          case LINK_TYPE.BACKBONE: return 300;
          case LINK_TYPE.NODE_TO_SUPER: return 140;
          case LINK_TYPE.PEER: return 100;
          case LINK_TYPE.OFFLINE: return 250;
          default: return 160;
        }
      })
      .strength((link) => {
        switch (link.linkType) {
          case LINK_TYPE.BACKBONE: return 0.5;
          case LINK_TYPE.NODE_TO_SUPER: return 0.3;
          case LINK_TYPE.PEER: return 0.1;
          case LINK_TYPE.OFFLINE: return 0.03;
          default: return 0.15;
        }
      });

    fg.d3Force('center').strength(0.02);
  }, []);

  const getNodeColor = (node) => {
    if (node.nodeType === 'supernode') {
      if (node.status !== 'online') return COLORS.supernodeDim;
      return node.isCore ? COLORS.supernodeCore : COLORS.carrierNode;
    }
    return node.status === 'online' ? COLORS.online : COLORS.offline;
  };

  const getNodeSize = (node) => {
    if (node.nodeType === 'supernode') {
      return node.isCore ? 20 : 12;
    }
    if (node.nodeType === 'pc2' && node.status === 'online') {
      return node.activityType === 'active' ? 8 : 6;
    }
    if (node.status === 'online') return 5;
    return 3.5;
  };

  // Animated node rendering with time-based effects
  const paintNode = useCallback((node, ctx) => {
    const size = getNodeSize(node);
    const color = getNodeColor(node);
    const t = Date.now() * 0.001;

    if (node.nodeType === 'supernode') {
      const isCore = node.isCore;
      const glowRadius = isCore ? 24 : 14;
      const ringAlpha = isCore ? 1.0 : 0.5;

      if (isCore) {
        // Core hubs: 2 pulsing rings
        const ring1 = size + 16 + Math.sin(t * 1.5) * 5;
        ctx.beginPath();
        ctx.arc(node.x, node.y, ring1, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(240, 185, 11, ${(0.08 + Math.sin(t * 1.5) * 0.04) * ringAlpha})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        const ring2 = size + 10 + Math.sin(t * 2.0 + 1) * 3;
        ctx.beginPath();
        ctx.arc(node.x, node.y, ring2, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(240, 185, 11, ${(0.12 + Math.sin(t * 2.0 + 1) * 0.06) * ringAlpha})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // Carrier nodes: single subtle ring
        const ring1 = size + 6 + Math.sin(t * 1.8 + 2) * 2;
        ctx.beginPath();
        ctx.arc(node.x, node.y, ring1, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(212, 165, 10, ${0.06 + Math.sin(t * 1.8 + 2) * 0.03})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Glow halo (larger for core)
      const gradient = ctx.createRadialGradient(node.x, node.y, size * 0.5, node.x, node.y, size + glowRadius);
      gradient.addColorStop(0, `rgba(240, 185, 11, ${isCore ? 0.25 : 0.15})`);
      gradient.addColorStop(0.6, `rgba(240, 185, 11, ${isCore ? 0.08 : 0.04})`);
      gradient.addColorStop(1, 'rgba(240, 185, 11, 0)');
      ctx.beginPath();
      ctx.arc(node.x, node.y, size + glowRadius, 0, 2 * Math.PI);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Core circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      if (isCore) {
        // Bright inner highlight for core hubs
        const innerGrad = ctx.createRadialGradient(node.x - size * 0.3, node.y - size * 0.3, 0, node.x, node.y, size);
        innerGrad.addColorStop(0, 'rgba(255, 240, 180, 0.5)');
        innerGrad.addColorStop(1, 'rgba(240, 185, 11, 0)');
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
        ctx.fillStyle = innerGrad;
        ctx.fill();
      }

      // Border
      ctx.strokeStyle = isCore ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = isCore ? 2 : 1;
      ctx.stroke();

      return;
    }

    if (node.status === 'online') {
      // Breathing outer glow
      const glowSize = size + 3 + Math.sin(t * 2 + node.x * 0.01) * 2;
      const gradient = ctx.createRadialGradient(node.x, node.y, size * 0.3, node.x, node.y, glowSize);
      gradient.addColorStop(0, `${color}66`);
      gradient.addColorStop(1, `${color}00`);
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowSize, 0, 2 * Math.PI);
      ctx.fillStyle = gradient;
      ctx.fill();

      // Core
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();

      return;
    }

    const offColor = 'rgba(245, 158, 11, 0.5)';
    const offBorder = 'rgba(245, 158, 11, 0.15)';

    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = offColor;
    ctx.fill();

    ctx.strokeStyle = offBorder;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }, []);

  // Link color by type
  const getLinkColor = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 'rgba(240, 185, 11, 0.4)';
      case LINK_TYPE.NODE_TO_SUPER: return 'rgba(34, 197, 94, 0.25)';
      case LINK_TYPE.PEER: return 'rgba(56, 189, 248, 0.2)';
      case LINK_TYPE.OFFLINE: return 'rgba(245, 158, 11, 0.06)';
      default: return 'rgba(100, 100, 100, 0.15)';
    }
  }, []);

  const getLinkWidth = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 2.5;
      case LINK_TYPE.NODE_TO_SUPER: return 1.2;
      case LINK_TYPE.PEER: return 0.8;
      case LINK_TYPE.OFFLINE: return 0.4;
      default: return 0.8;
    }
  }, []);

  const getLinkCurvature = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 0.25;
      case LINK_TYPE.PEER: return 0.15;
      default: return 0;
    }
  }, []);

  const getLinkParticles = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 4;
      case LINK_TYPE.NODE_TO_SUPER: return 2;
      case LINK_TYPE.PEER: return 1;
      default: return 0;
    }
  }, []);

  const getLinkParticleSpeed = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 0.006;
      case LINK_TYPE.NODE_TO_SUPER: return 0.004;
      case LINK_TYPE.PEER: return 0.003;
      default: return 0;
    }
  }, []);

  const getLinkParticleWidth = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 3;
      case LINK_TYPE.NODE_TO_SUPER: return 2;
      case LINK_TYPE.PEER: return 1.5;
      default: return 0;
    }
  }, []);

  const getLinkParticleColor = useCallback((link) => {
    switch (link.linkType) {
      case LINK_TYPE.BACKBONE: return 'rgba(240, 185, 11, 0.8)';
      case LINK_TYPE.NODE_TO_SUPER: return 'rgba(34, 197, 94, 0.7)';
      case LINK_TYPE.PEER: return 'rgba(56, 189, 248, 0.6)';
      default: return 'transparent';
    }
  }, []);

  // Background: subtle dot grid + radial glow zones behind supernodes
  const paintBackground = useCallback((ctx, globalScale) => {
    const { width, height } = dimensions;
    const graphTransform = graphRef.current?.screen2GraphCoords(0, 0) || { x: 0, y: 0 };
    const graphBR = graphRef.current?.screen2GraphCoords(width, height) || { x: width, y: height };

    const left = graphTransform.x;
    const top = graphTransform.y;
    const right = graphBR.x;
    const bottom = graphBR.y;

    // Dot grid
    const gridSpacing = 50;
    const startX = Math.floor(left / gridSpacing) * gridSpacing;
    const startY = Math.floor(top / gridSpacing) * gridSpacing;

    ctx.fillStyle = COLORS.gridDot;
    for (let x = startX; x < right; x += gridSpacing) {
      for (let y = startY; y < bottom; y += gridSpacing) {
        ctx.beginPath();
        ctx.arc(x, y, 0.8, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // Radial glow zones behind each supernode (larger for core hubs)
    const supernodePositions = (graphData.nodes || []).filter(n => n.nodeType === 'supernode' && n.x != null);
    for (const sn of supernodePositions) {
      const radius = sn.isCore ? 220 : 120;
      const intensity = sn.isCore ? 0.05 : 0.025;
      const gradient = ctx.createRadialGradient(sn.x, sn.y, 0, sn.x, sn.y, radius);
      gradient.addColorStop(0, `rgba(240, 185, 11, ${intensity})`);
      gradient.addColorStop(0.5, `rgba(240, 185, 11, ${intensity * 0.35})`);
      gradient.addColorStop(1, 'rgba(240, 185, 11, 0)');
      ctx.beginPath();
      ctx.arc(sn.x, sn.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }, [dimensions, graphData.nodes]);

  return (
    <div className="network-map" ref={containerRef}>
      {nodes.length === 0 ? (
        <div className="network-map-loading">
          <p>No nodes to display</p>
        </div>
      ) : (
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.beginPath();
            ctx.arc(node.x, node.y, getNodeSize(node) + 8, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
          }}
          linkColor={getLinkColor}
          linkWidth={getLinkWidth}
          linkCurvature={getLinkCurvature}
          linkDirectionalParticles={getLinkParticles}
          linkDirectionalParticleSpeed={getLinkParticleSpeed}
          linkDirectionalParticleWidth={getLinkParticleWidth}
          linkDirectionalParticleColor={getLinkParticleColor}
          onRenderFramePre={paintBackground}
          backgroundColor="#0c0c0e"
          width={dimensions.width}
          height={dimensions.height}
          d3AlphaDecay={0.015}
          d3VelocityDecay={0.35}
          warmupTicks={80}
          cooldownTicks={200}
          onEngineStop={handleEngineInit}
          enableNodeDrag={true}
          onNodeDragEnd={(node) => {
            node.fx = node.x;
            node.fy = node.y;
          }}
          enableZoom={true}
          enablePan={true}
          minZoom={0.3}
          maxZoom={5}
          nodeLabel={(node) => {
            let type = 'Registered';
            if (node.nodeType === 'supernode') {
              type = node.isCore ? 'Core Supernode' : 'Relay Node';
            } else if (node.nodeType === 'pc2') {
              type = 'PC2 Node';
            }
            return `${type} | ${node.id} | ${node.status}`;
          }}
          onNodeClick={(node) => {
            node.fx = null;
            node.fy = null;
          }}
        />
      )}
    </div>
  );
}

export default NetworkGraph;
