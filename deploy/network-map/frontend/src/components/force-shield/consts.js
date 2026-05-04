export const MAX_HITS = 6;

export const SHIELD_SPHERE_RADIUS = 1.8;

export const MAP_API_BASE = "";
export const MAP_WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

export const NODE_COLORS = {
  supernode: "#e2c478",
  online: "#2dd4bf",
  offline: "#ffffff",
};

export const NODE_SIZES = {
  supernode: 8.0,
  online: 5.0,
  offline: 3.0,
};

export const CONNECTION_COLORS = {
  supernodeBackbone: "#c9944a",
  supernodeToNode: "#22d3ee",
  liveToLive: "#3b82f6",
  dormant: "#1e3a5f",
};

export const CONNECTION_MAX_ANGLE = 1.8;
export const MAX_CONNECTIONS_PER_NODE = 5;
export const SIGNAL_COUNT = 120;
export const SIGNAL_SPEED = 0.15;
export const ARC_INWARD_FACTOR = 0.6;

export const DEFAULT_SHIELD_CONFIG = {
  debugAlwaysOn: true,
  manualReveal: false,
  revealProgress: 0,
  posX: 0,
  posY: 0,
  posZ: 0,
  scale: 0.85,
  color: "#ffffff",
  hexScale: 3.0,
  hexOpacity: 0,
  showHex: false,
  edgeWidth: 0.06,
  fresnelPower: 1.8,
  fresnelStrength: 1.75,
  opacity: 0.76,
  fadeStart: 0,
  revealSpeed: 3.5,
  flashSpeed: 0.6,
  flashIntensity: 0.11,
  noiseScale: 1.3,
  noiseEdgeColor: "#ffffff",
  noiseEdgeWidth: 0.02,
  noiseEdgeIntensity: 10,
  noiseEdgeSmoothness: 0.5,
  flowScale: 2.4,
  flowSpeed: 1.13,
  flowIntensity: 4,
  hitRingSpeed: 1.75,
  hitRingWidth: 0.12,
  hitMaxRadius: 0.85,
  hitDuration: 1.8,
  hitIntensity: 4.1,
  hitImpactRadius: 0.3,
  hitDamage: 5,
};
