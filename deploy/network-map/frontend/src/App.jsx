import React, { useState, useEffect, useCallback, useRef } from 'react';
import NetworkGraph from './components/NetworkGraph';
import NodeList from './components/NodeList';
import { ShieldScene } from './components/force-shield/ShieldScene';

function formatActivity(type) {
  switch (type) {
    case 'active': return 'Active';
    case 'occasional': return 'Occasional';
    case 'idle': return 'Idle';
    default: return '-';
  }
}

function App() {
  const [stats, setStats] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  
  const fetchData = useCallback(async () => {
    try {
      const [statsRes, nodesRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/nodes')
      ]);
      
      if (!statsRes.ok || !nodesRes.ok) {
        throw new Error('Failed to fetch data');
      }
      
      const statsData = await statsRes.json();
      const nodesData = await nodesRes.json();
      
      setStats(statsData);
      setNodes(nodesData.nodes || []);
      setError(null);
    } catch (err) {
      console.error('Fetch error:', err);
      setError('Unable to load network data');
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    fetchData();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    function connect() {
      wsRef.current = new WebSocket(wsUrl);
      
      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'stats_update') {
            setStats(message.data);
          } else if (message.type === 'node_change') {
            fetchData();
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };
      
      wsRef.current.onclose = () => setTimeout(connect, 5000);
      wsRef.current.onerror = (err) => console.error('WebSocket error:', err);
    }
    
    connect();
    return () => wsRef.current?.close();
  }, [fetchData]);

  const supernodes = nodes.filter(n => n.nodeType === 'supernode');
  const onlineNodes = nodes.filter(n => n.status === 'online' && n.nodeType !== 'supernode');
  const offlineNodes = nodes.filter(n => n.status !== 'online' && n.nodeType !== 'supernode');
  
  return (
    <div className="app single-page">
      {/* Compact Header */}
      <header className="header compact">
        <h1>ElastOS World Computer Network</h1>
        <div className="header-right">
          <a href="https://docs.ela.city/cloud/getting-started" target="_blank" rel="noopener" className="setup-link">
            Set up your node
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </a>
          <a href="https://elacitylabs.com" target="_blank" rel="noopener" className="header-logo-link">
            <img src="/images/elacity-labs-logo.svg" alt="Elacity Labs" />
          </a>
        </div>
      </header>
      
      <main className="main compact">
        {loading ? (
          <div className="loading-state">Loading network data...</div>
        ) : error ? (
          <div className="error-state">{error}</div>
        ) : (
          <div className="scrollable-layout">
            {/* Stats Bar */}
            <div className="stats-bar" role="status" aria-live="polite">
              <div className="stat-pill online">
                <span className="stat-dot online"></span>
                <span className="stat-num">{stats?.onlineNow || 0}</span>
                <span className="stat-text">Online</span>
              </div>
              <div className="stat-pill">
                <span className="stat-num">{stats?.totalRegistered || 0}</span>
                <span className="stat-text">Total Nodes</span>
              </div>
              <div className="stat-pill supernode">
                <span className="stat-dot supernode"></span>
                <span className="stat-num">{supernodes.length}</span>
                <span className="stat-text">{supernodes.length === 1 ? 'Supernode' : 'Supernodes'}</span>
              </div>
            </div>
            
            {/* Graph Row — Orb + 2D side by side */}
            <div className="graph-row">
              <section className="graph-panel orb-panel" aria-label="Interactive 3D visualization of live ElastOS world computer nodes">
                <span className="panel-label">World Computer</span>
                <ShieldScene />
              </section>
              <section className="graph-panel network-panel" aria-label="Network topology graph showing node connections and supernode backbone">
                <span className="panel-label">Network Graph</span>
                <div className="graph-help">
                  Drag nodes • Scroll to zoom • Hover for info
                </div>
                <div className="graph-legend">
                  <div className="legend-item"><span className="legend-dot supernode"></span>Supernode</div>
                  <div className="legend-item"><span className="legend-dot online"></span>Online</div>
                  <div className="legend-item"><span className="legend-dot peer"></span>Peer Link</div>
                  <div className="legend-item"><span className="legend-dot offline"></span>Offline</div>
                </div>
                <div className="privacy-badge">
                  <svg className="lock-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                  Anonymized - No URLs or IPs exposed
                </div>
                <NetworkGraph nodes={nodes} />
              </section>
            </div>
            
            {/* Node List Section */}
            <section className="nodes-section">
              <h2 className="section-title">Network Nodes ({nodes.length})</h2>
              
              <div className="node-list-table">
                <div className="node-list-header">
                  <span className="col-status">Status</span>
                  <span className="col-id">Node ID</span>
                  <span className="col-type">Type</span>
                  <span className="col-activity">Activity</span>
                </div>
                
                {/* Supernodes first */}
                {supernodes.map(node => (
                  <div key={node.nodeIdentifier} className={`node-row supernode ${node.status}`}>
                    <span className="col-status">
                      <span className={`status-indicator ${node.status}`}></span>
                      {node.status}
                    </span>
                    <span className="col-id">{node.nodeIdentifier}</span>
                    <span className="col-type supernode-badge">Supernode</span>
                    <span className="col-activity">Active</span>
                  </div>
                ))}
                
                {/* Online nodes */}
                {onlineNodes.map(node => (
                  <div key={node.nodeIdentifier} className={`node-row online`}>
                    <span className="col-status">
                      <span className="status-indicator online"></span>
                      online
                    </span>
                    <span className="col-id">{node.nodeIdentifier}</span>
                    <span className={`col-type ${node.nodeType === 'pc2' ? 'pc2-badge' : ''}`}>{node.nodeType}</span>
                    <span className="col-activity">{formatActivity(node.activityType)}</span>
                  </div>
                ))}
                
                {/* Offline nodes */}
                {offlineNodes.map(node => (
                  <div key={node.nodeIdentifier} className={`node-row offline`}>
                    <span className="col-status">
                      <span className="status-indicator offline"></span>
                      offline
                    </span>
                    <span className="col-id">{node.nodeIdentifier}</span>
                    <span className={`col-type ${node.nodeType === 'pc2' ? 'pc2-badge' : ''}`}>{node.nodeType}</span>
                    <span className="col-activity">{formatActivity(node.activityType)}</span>
                  </div>
                ))}
              </div>
            </section>
            
            {/* SEO Content Section */}
            <section className="seo-section" aria-labelledby="about-heading">
              <h2 id="about-heading" className="seo-heading">About the ElastOS World Computer</h2>
              <p>
                The ElastOS World Computer is a decentralized network of sovereign nodes
                running Personal Cloud Compute (PC2) — the open-source CloudOS built by
                Elacity Labs. Each node is a privately owned computer: a laptop, a VPS,
                a Raspberry Pi, an NVIDIA Jetson. Together, they form a world computer
                owned by its participants.
              </p>
              <p>
                Supernodes anchor the backbone, routing encrypted communications between
                peers. Regular nodes run decentralized applications, store encrypted data,
                and process AI workloads — all locally, never leaving the owner's machine.
                Every connection is peer-to-peer. Every right is tokenized on-chain.
              </p>
              <p>
                This map shows the live state of the network. Node status updates in
                real-time via WebSocket. The 3D globe represents the world computer as
                a unified organism. The topology graph reveals the peer mesh connecting
                sovereign machines under blockchain law.
              </p>

              <h3 className="seo-subheading">How to Join</h3>
              <p>
                Anyone can run an ElastOS node. Install the CloudOS on your hardware,
                register on-chain, and your node appears on this map.{' '}
                <a href="https://docs.ela.city/cloud/getting-started" target="_blank" rel="noopener">Set up your node →</a>
              </p>

              <h3 className="seo-subheading">Network Stats</h3>
              <p>
                The ElastOS network currently has <strong>{stats?.totalRegistered || 0}</strong> registered
                nodes with <strong>{stats?.onlineNow || 0}</strong> currently online and{' '}
                <strong>{supernodes.length}</strong> supernodes anchoring the backbone.
                Backed by a <a href="https://www.cyberrepublic.org/proposals/212" target="_blank" rel="noopener">$3M DAO mandate</a> for
                continuous development.
              </p>
            </section>
          </div>
        )}
      </main>
      
      <footer className="footer compact">
        <div className="footer-left">
          <span>Data updates every 5 min</span>
          <span>•</span>
          <a href="https://elacitylabs.com" target="_blank" rel="noopener">Elacity Labs</a>
          <span>•</span>
          <a href="https://ela.city" target="_blank" rel="noopener">Exchange</a>
          <span>•</span>
          <a href="https://docs.ela.city" target="_blank" rel="noopener">Docs</a>
          <span>•</span>
          <a href="https://docs.ela.city/cloud/getting-started" target="_blank" rel="noopener">Run a Node</a>
        </div>
        <div className="footer-logo">
          <img src="/images/elacity-labs-logo.svg" alt="Elacity Labs — Building the world computer you own" />
        </div>
      </footer>
    </div>
  );
}

export default App;
