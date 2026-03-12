import { useState, useEffect, useRef, useCallback } from "react";
import { MAP_API_BASE, MAP_WS_URL, SHIELD_SPHERE_RADIUS } from "./consts";

function nodeToGeoPosition(nodeId) {
  let hash = 0;
  for (let i = 0; i < nodeId.length; i++) {
    hash = ((hash << 5) - hash) + nodeId.charCodeAt(i);
    hash |= 0;
  }
  const lat = ((hash & 0xffff) / 0xffff) * 180 - 90;
  const lng = (((hash >> 16) & 0xffff) / 0xffff) * 360 - 180;
  return { lat, lng };
}

function latLngToVec3(lat, lng, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

function mapRawNode(raw, radius) {
  const { lat, lng } = nodeToGeoPosition(raw.nodeIdentifier);
  return {
    id: raw.nodeIdentifier,
    position: latLngToVec3(lat, lng, radius),
    status: raw.status,
    nodeType: raw.nodeType,
  };
}

const WS_RECONNECT_DELAY = 5_000;
const POINT_RADIUS = SHIELD_SPHERE_RADIUS * 0.7;

export function useNetworkNodes() {
  const [nodes, setNodes] = useState([]);
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef(null);
  const reconnectTimer = useRef();
  const mountedRef = useRef(true);

  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch(`${MAP_API_BASE}/api/nodes?limit=500`);
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      const mapped = (data.nodes).map((n) =>
        mapRawNode(n, POINT_RADIUS)
      );
      setNodes(mapped);
    } catch {
      /* network error – keep previous state */
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${MAP_API_BASE}/api/stats/summary`);
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      setStats(data);
    } catch {
      /* swallow */
    }
  }, []);

  const connectWS = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      const ws = new WebSocket(MAP_WS_URL);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "stats_update" && msg.data) {
            setStats({
              onlineNow: msg.data.onlineNow ?? 0,
              totalNodes: msg.data.totalRegistered ?? msg.data.totalNodes ?? 0,
              active: msg.data.activityDistribution?.active ?? 0,
              occasional: msg.data.activityDistribution?.occasional ?? 0,
            });
          }

          if (msg.type === "node_change" && msg.data) {
            const { nodeIdentifier, newStatus } = msg.data;
            setNodes((prev) =>
              prev.map((n) =>
                n.id === nodeIdentifier ? { ...n, status: newStatus } : n
              )
            );
          }
        } catch {
          /* ignore malformed messages */
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (mountedRef.current) {
          reconnectTimer.current = setTimeout(connectWS, WS_RECONNECT_DELAY);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      reconnectTimer.current = setTimeout(connectWS, WS_RECONNECT_DELAY);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    Promise.all([fetchNodes(), fetchStats()]).finally(() => {
      if (mountedRef.current) setIsLoading(false);
    });

    connectWS();

    return () => {
      mountedRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [fetchNodes, fetchStats, connectWS]);

  return { nodes, stats, isLoading };
}
