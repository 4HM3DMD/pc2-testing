/**
 * Database Module
 * 
 * SQLite database for persistent storage of users, sessions, files, and settings
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { runMigrations } from './migrations.js';
import { encryptApiKeys, decryptApiKeys } from '../utils/encryption.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');

export interface User {
  wallet_address: string;
  smart_account_address: string | null;
  created_at: number;
  last_login: number | null;
}

export interface Session {
  token: string;
  wallet_address: string;
  smart_account_address: string | null;
  created_at: number;
  expires_at: number;
}

export interface FileMetadata {
  path: string;
  wallet_address: string;
  ipfs_hash: string | null;
  size: number;
  mime_type: string | null;
  thumbnail: string | null;
  content_text: string | null;
  is_dir: boolean;
  is_public: boolean;
  created_at: number;
  updated_at: number;
}

export interface Setting {
  key: string;
  value: string;
  updated_at: number;
}

export interface FileVersion {
  id: number;
  file_path: string;
  wallet_address: string;
  version_number: number;
  ipfs_hash: string;
  size: number;
  mime_type: string | null;
  created_at: number;
  created_by: string | null;
  comment: string | null;
}

export interface AIConfig {
  wallet_address: string;
  default_provider: string;
  default_model: string | null;
  api_keys: string; // JSON string: { "openai": "sk-...", "claude": "sk-ant-..." }
  ollama_base_url: string;
  updated_at: number;
}

export interface AIConversation {
  id: string;
  wallet_address: string;
  title: string;
  messages_json: string; // JSON string array of messages
  created_at: number;
  updated_at: number;
}

export interface ContentCatalogItem {
  id?: number;
  content_id: string | null;
  channel_address: string;
  token_id: number;
  operative_address: string | null;
  creator_address: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  content_cid: string | null;
  metadata_cid: string | null;
  mime_type: string | null;
  asset_type: string | null;
  price: string | null;
  payment_token: string | null;
  op_type: number | null;
  chain_id: number;
  block_number: number;
  tx_hash: string | null;
  contract_version: string;
  metadata_status: 'pending' | 'resolved' | 'failed';
  indexed_at: number;
  metadata_json: string | null;
}

export interface InstalledApp {
  app_name: string;
  title: string;
  version: string;
  cid: string;
  size: number;
  icon: string | null;
  description: string | null;
  author: string | null;
  permissions_json: string;
  requirements_json: string;
  manifest_json: string;
  installed_at: number;
  updated_at: number;
}

export class DatabaseManager {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  getDatabase(): Database.Database | null {
    return this.db;
  }

  /**
   * Initialize database connection and run migrations
   */
  initialize(): void {
    if (this.db) {
      return; // Already initialized
    }

    // Ensure data directory exists
    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Open database connection
    this.db = new Database(this.dbPath);
    
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    
    // Run migrations
    runMigrations(this.db);

    log.info(`Database initialized: ${this.dbPath}`);
  }

  /**
   * Get database instance (throws if not initialized)
   */
  getDB(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      log.info('Database connection closed');
    }
  }

  // ============================================================================
  // User Operations
  // ============================================================================

  /**
   * Create or update user
   */
  createOrUpdateUser(walletAddress: string, smartAccountAddress: string | null = null): void {
    const db = this.getDB();
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (wallet_address, smart_account_address, created_at, last_login)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        smart_account_address = excluded.smart_account_address,
        last_login = excluded.last_login
    `).run(walletAddress, smartAccountAddress, now, now);
  }

  /**
   * Get user by wallet address
   */
  getUser(walletAddress: string): User | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM users WHERE wallet_address = ?').get(walletAddress) as User | undefined;
    return row ?? null;
  }

  /**
   * Update user's last login time
   */
  updateLastLogin(walletAddress: string): void {
    const db = this.getDB();
    db.prepare('UPDATE users SET last_login = ? WHERE wallet_address = ?')
      .run(Date.now(), walletAddress);
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * Create session
   */
  createSession(session: Session): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO sessions (token, wallet_address, smart_account_address, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      session.token,
      session.wallet_address,
      session.smart_account_address,
      session.created_at,
      session.expires_at
    );
  }

  /**
   * Get session by token
   */
  getSession(token: string): Session | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as Session | undefined;
    return row ?? null;
  }

  /**
   * Get session by wallet address (most recent)
   */
  getSessionByWallet(walletAddress: string): Session | null {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT * FROM sessions 
      WHERE wallet_address = ? AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(walletAddress, Date.now()) as Session | undefined;
    return row ?? null;
  }

  /**
   * Get all active sessions (not expired)
   */
  getAllActiveSessions(): Session[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT * FROM sessions 
      WHERE expires_at > ?
      ORDER BY created_at DESC
    `).all(Date.now()) as Session[];
    return rows;
  }

  /**
   * Update session smart account address
   */
  updateSessionSmartAccount(token: string, smartAccountAddress: string): void {
    const db = this.getDB();
    db.prepare('UPDATE sessions SET smart_account_address = ? WHERE token = ?').run(smartAccountAddress, token);
  }

  /**
   * Delete session
   */
  deleteSession(token: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /**
   * Delete expired sessions
   */
  cleanupExpiredSessions(): number {
    const db = this.getDB();
    const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    return result.changes;
  }

  /**
   * Delete all sessions for a wallet
   */
  deleteSessionsByWallet(walletAddress: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM sessions WHERE wallet_address = ?').run(walletAddress);
  }

  /**
   * Update session expiration time
   */
  updateSessionExpiration(token: string, newExpiresAt: number): void {
    const db = this.getDB();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(newExpiresAt, token);
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Create or update file metadata
   */
  createOrUpdateFile(metadata: FileMetadata): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO files (path, wallet_address, ipfs_hash, size, mime_type, thumbnail, content_text, is_dir, is_public, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path, wallet_address) DO UPDATE SET
        ipfs_hash = excluded.ipfs_hash,
        size = excluded.size,
        mime_type = excluded.mime_type,
        thumbnail = excluded.thumbnail,
        content_text = excluded.content_text,
        is_dir = excluded.is_dir,
        is_public = excluded.is_public,
        updated_at = excluded.updated_at
    `).run(
      metadata.path,
      metadata.wallet_address,
      metadata.ipfs_hash,
      metadata.size,
      metadata.mime_type,
      metadata.thumbnail || null,
      metadata.content_text || null,
      metadata.is_dir ? 1 : 0,
      metadata.is_public ? 1 : 0,
      metadata.created_at,
      metadata.updated_at
    );
  }

  /**
   * Get file metadata
   */
  getFile(path: string, walletAddress: string): FileMetadata | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM files WHERE path = ? AND wallet_address = ?')
      .get(path, walletAddress) as any;

    if (!row) {
      return null;
    }

    return {
      ...row,
      content_text: row.content_text ?? null, // Ensure content_text is always present (even if NULL)
      is_dir: row.is_dir === 1,
      is_public: row.is_public === 1
    };
  }

  /**
   * List files in directory
   */
  listFiles(directoryPath: string, walletAddress: string): FileMetadata[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT * FROM files 
      WHERE path LIKE ? AND wallet_address = ?
      ORDER BY is_dir DESC, path ASC
    `).all(`${directoryPath}%`, walletAddress) as any[];

    return rows.map(row => ({
      ...row,
      content_text: row.content_text ?? null, // Ensure content_text is always present (even if NULL)
      is_dir: row.is_dir === 1,
      is_public: row.is_public === 1
    }));
  }

  /**
   * Delete file metadata
   */
  deleteFile(path: string, walletAddress: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM files WHERE path = ? AND wallet_address = ?')
      .run(path, walletAddress);
  }

  /**
   * Delete all files for a wallet (cascade on user delete)
   */
  deleteFilesByWallet(walletAddress: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM files WHERE wallet_address = ?').run(walletAddress);
  }

  // ============================================================================
  // Public File Operations (for IPFS Gateway)
  // ============================================================================

  /**
   * Get file metadata by IPFS CID (hash)
   * Used for serving content via /ipfs/:cid gateway
   */
  getFileByCID(cid: string): FileMetadata | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM files WHERE ipfs_hash = ? LIMIT 1')
      .get(cid) as any;

    if (!row) {
      return null;
    }

    return {
      ...row,
      content_text: row.content_text ?? null,
      is_dir: row.is_dir === 1,
      is_public: row.is_public === 1
    };
  }

  /**
   * Get all public files for a wallet
   * Optionally filter by base path (for directory listings)
   */
  getPublicFiles(walletAddress: string, basePath?: string): FileMetadata[] {
    const db = this.getDB();
    
    let query: string;
    let params: string[];
    
    if (basePath) {
      // Get direct children of the specified path (path-based public detection)
      query = `
        SELECT * FROM files 
        WHERE wallet_address = ? 
          AND path LIKE '%/Public/%'
          AND path LIKE ?
          AND path NOT LIKE ?
        ORDER BY is_dir DESC, path ASC
      `;
      // Match direct children only (path/% but not path/%/%)
      params = [walletAddress, `${basePath}/%`, `${basePath}/%/%`];
    } else {
      // Get all public files (in /Public folder) - path-based detection
      query = `
        SELECT * FROM files 
        WHERE wallet_address = ? 
          AND path LIKE ?
        ORDER BY is_dir DESC, path ASC
      `;
      params = [walletAddress, `/${walletAddress}/Public/%`];
    }

    const rows = db.prepare(query).all(...params) as any[];

    return rows.map(row => ({
      ...row,
      content_text: row.content_text ?? null,
      is_dir: row.is_dir === 1,
      is_public: row.is_public === 1
    }));
  }

  /**
   * Get statistics for public files
   */
  getPublicStats(): { publicFileCount: number; totalPublicSize: number } {
    const db = this.getDB();
    // Use path-based detection: files in /*/Public/* are public
    const row = db.prepare(`
      SELECT 
        COUNT(*) as count,
        COALESCE(SUM(size), 0) as total_size
      FROM files 
      WHERE path LIKE '%/Public/%' AND is_dir = 0
    `).get() as { count: number; total_size: number };

    return {
      publicFileCount: row.count,
      totalPublicSize: row.total_size
    };
  }

  /**
   * Check if a CID is publicly accessible
   */
  isPublicCID(cid: string): boolean {
    const db = this.getDB();
    // Use path-based detection: files in /*/Public/* are public
    const row = db.prepare(`
      SELECT 1 FROM files 
      WHERE ipfs_hash = ? AND path LIKE '%/Public/%'
      LIMIT 1
    `).get(cid);
    return !!row;
  }

  /**
   * Get all public CIDs for DHT announcement
   * Returns distinct CIDs from files marked as public (is_public=1) or in /Public folders
   */
  getPublicCIDs(): string[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT DISTINCT ipfs_hash 
      FROM files 
      WHERE ipfs_hash IS NOT NULL 
        AND is_dir = 0
        AND (is_public = 1 OR path LIKE '%/Public/%')
    `).all() as { ipfs_hash: string }[];
    
    return rows.map(r => r.ipfs_hash);
  }

  /**
   * Get public CID count for statistics
   */
  getPublicCIDCount(): number {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT COUNT(DISTINCT ipfs_hash) as count
      FROM files 
      WHERE ipfs_hash IS NOT NULL 
        AND is_dir = 0
        AND (is_public = 1 OR path LIKE '%/Public/%')
    `).get() as { count: number };
    
    return row?.count || 0;
  }

  // ============================================================================
  // Pinned CID Tracking (Marketplace Purchases & CDN)
  // ============================================================================

  trackPinnedCID(cid: string, walletAddress: string, size: number, source: string = 'marketplace'): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO pinned_cids (cid, wallet_address, source, size, pinned_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cid, wallet_address) DO UPDATE SET
        size = excluded.size,
        source = excluded.source
    `).run(cid, walletAddress, source, size, Date.now());
  }

  getPinnedCIDs(walletAddress?: string): string[] {
    const db = this.getDB();
    if (walletAddress) {
      const rows = db.prepare(`SELECT cid FROM pinned_cids WHERE wallet_address = ?`).all(walletAddress) as { cid: string }[];
      return rows.map(r => r.cid);
    }
    const rows = db.prepare(`SELECT DISTINCT cid FROM pinned_cids`).all() as { cid: string }[];
    return rows.map(r => r.cid);
  }

  getAllAnnouncableCIDs(): string[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT cid FROM pinned_cids
      UNION
      SELECT DISTINCT ipfs_hash as cid FROM files
      WHERE ipfs_hash IS NOT NULL AND is_dir = 0
        AND (is_public = 1 OR path LIKE '%/Public/%')
    `).all() as { cid: string }[];
    return rows.map(r => r.cid);
  }

  updatePinnedCIDAnnouncedAt(cid: string): void {
    const db = this.getDB();
    db.prepare(`UPDATE pinned_cids SET last_announced_at = ? WHERE cid = ?`).run(Date.now(), cid);
  }

  // ============================================================================
  // Content Seeding — Serve Tracking & Pin Status
  // ============================================================================

  updateServeStats(cid: string): void {
    const db = this.getDB();
    db.prepare(`
      UPDATE pinned_cids
      SET last_served_at = ?, serve_count = serve_count + 1
      WHERE cid = ?
    `).run(Date.now(), cid);
  }

  updatePinStatus(cid: string, status: 'queued' | 'pinning' | 'complete' | 'failed'): void {
    const db = this.getDB();
    db.prepare(`UPDATE pinned_cids SET pin_status = ? WHERE cid = ?`).run(status, cid);
  }

  isCIDPinnedOrQueued(cid: string): boolean {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT 1 FROM pinned_cids WHERE cid = ? AND pin_status IN ('queued', 'pinning', 'complete')
    `).get(cid);
    return !!row;
  }

  getIncompletePins(): Array<{ cid: string; wallet_address: string; size: number }> {
    const db = this.getDB();
    return db.prepare(`
      SELECT cid, wallet_address, size FROM pinned_cids
      WHERE pin_status IN ('queued', 'pinning', 'failed')
    `).all() as Array<{ cid: string; wallet_address: string; size: number }>;
  }

  getHotCIDs(): string[] {
    const db = this.getDB();
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const rows = db.prepare(`
      SELECT DISTINCT cid FROM pinned_cids
      WHERE last_served_at IS NOT NULL AND last_served_at > ? AND pin_status = 'complete'
    `).all(cutoff) as { cid: string }[];
    return rows.map(r => r.cid);
  }

  getWarmCIDs(): string[] {
    const db = this.getDB();
    const hotCutoff = Date.now() - (24 * 60 * 60 * 1000);
    const warmCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const rows = db.prepare(`
      SELECT DISTINCT cid FROM pinned_cids
      WHERE last_served_at IS NOT NULL AND last_served_at > ? AND last_served_at <= ? AND pin_status = 'complete'
    `).all(warmCutoff, hotCutoff) as { cid: string }[];
    return rows.map(r => r.cid);
  }

  getColdCIDs(): string[] {
    const db = this.getDB();
    const warmCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const rows = db.prepare(`
      SELECT DISTINCT cid FROM pinned_cids
      WHERE (last_served_at IS NULL OR last_served_at <= ?) AND pin_status = 'complete'
    `).all(warmCutoff) as { cid: string }[];
    return rows.map(r => r.cid);
  }

  removePinnedCID(cid: string): void {
    const db = this.getDB();
    db.prepare(`DELETE FROM pinned_cids WHERE cid = ?`).run(cid);
  }

  getTotalPinnedSize(): number {
    const db = this.getDB();
    const row = db.prepare(`SELECT COALESCE(SUM(size), 0) as total FROM pinned_cids WHERE pin_status = 'complete'`).get() as { total: number };
    return row.total;
  }

  // ============================================================================
  // Settings Operations
  // ============================================================================

  /**
   * Get setting value
   */
  getSetting(key: string): string | null {
    const db = this.getDB();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set setting value
   */
  setSetting(key: string, value: string): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  /**
   * Delete setting
   */
  deleteSetting(key: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /**
   * Get all settings
   */
  getAllSettings(): Setting[] {
    const db = this.getDB();
    return db.prepare('SELECT * FROM settings').all() as Setting[];
  }

  // ============================================================================
  // File Version Operations
  // ============================================================================

  /**
   * Create a new file version snapshot
   */
  createFileVersion(version: Omit<FileVersion, 'id'>): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO file_versions (
        file_path, wallet_address, version_number, ipfs_hash, 
        size, mime_type, created_at, created_by, comment
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.file_path,
      version.wallet_address,
      version.version_number,
      version.ipfs_hash,
      version.size,
      version.mime_type || null,
      version.created_at,
      version.created_by || null,
      version.comment || null
    );
  }

  /**
   * Get all versions for a file (ordered by version number, newest first)
   */
  getFileVersions(filePath: string, walletAddress: string): FileVersion[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT * FROM file_versions
      WHERE file_path = ? AND wallet_address = ?
      ORDER BY version_number DESC
    `).all(filePath, walletAddress) as FileVersion[];
    return rows;
  }

  /**
   * Get a specific version of a file
   */
  getFileVersion(filePath: string, walletAddress: string, versionNumber: number): FileVersion | null {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT * FROM file_versions
      WHERE file_path = ? AND wallet_address = ? AND version_number = ?
    `).get(filePath, walletAddress, versionNumber) as FileVersion | undefined;
    return row ?? null;
  }

  /**
   * Get the next version number for a file
   */
  getNextVersionNumber(filePath: string, walletAddress: string): number {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT MAX(version_number) as max_version
      FROM file_versions
      WHERE file_path = ? AND wallet_address = ?
    `).get(filePath, walletAddress) as { max_version: number | null } | undefined;
    return (row?.max_version ?? 0) + 1;
  }

  /**
   * Delete all versions for a file (when file is deleted)
   */
  deleteFileVersions(filePath: string, walletAddress: string): void {
    const db = this.getDB();
    db.prepare(`
      DELETE FROM file_versions
      WHERE file_path = ? AND wallet_address = ?
    `).run(filePath, walletAddress);
  }

  /**
   * Update file path for all versions (when file is renamed/moved)
   */
  updateFileVersionPaths(oldPath: string, newPath: string, walletAddress: string): void {
    const db = this.getDB();
    db.prepare(`
      UPDATE file_versions
      SET file_path = ?
      WHERE file_path = ? AND wallet_address = ?
    `).run(newPath, oldPath, walletAddress);
  }

  /**
   * Get version count for a file
   */
  getVersionCount(filePath: string, walletAddress: string): number {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM file_versions
      WHERE file_path = ? AND wallet_address = ?
    `).get(filePath, walletAddress) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Execute a raw SQL query (for custom queries not covered by standard methods)
   * Use with caution - prefer using standard methods when possible
   * Returns all rows
   */
  query(sql: string, ...params: any[]): any[] {
    const db = this.getDB();
    return db.prepare(sql).all(...params) as any[];
  }

  /**
   * Execute a raw SQL query and return single row
   * Returns single row or undefined
   */
  queryOne(sql: string, ...params: any[]): any {
    const db = this.getDB();
    return db.prepare(sql).get(...params);
  }

  // ============================================================================
  // AI Configuration Operations (Wallet-Scoped)
  // ============================================================================

  /**
   * Get AI configuration for a wallet (raw, without decryption - for internal use)
   */
  getAIConfigRaw(walletAddress: string): AIConfig | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM ai_config WHERE wallet_address = ?')
      .get(walletAddress) as AIConfig | undefined;
    return row ?? null;
  }

  /**
   * Get AI configuration for a wallet with decrypted API keys
   */
  getAIConfig(walletAddress: string): AIConfig | null {
    const config = this.getAIConfigRaw(walletAddress);
    if (!config) {
      return null;
    }
    
    // Decrypt API keys if present
    if (config.api_keys) {
      try {
        const encryptedKeys = JSON.parse(config.api_keys);
        const decryptedKeys = decryptApiKeys(encryptedKeys);
        config.api_keys = JSON.stringify(decryptedKeys);
      } catch (e) {
        // If parsing/decryption fails, return as-is (legacy data)
      }
    }
    
    return config;
  }

  /**
   * Create or update AI configuration
   */
  setAIConfig(
    walletAddress: string,
    defaultProvider: string = 'ollama',
    defaultModel: string | null = null,
    apiKeys: Record<string, string> | null = null,
    ollamaBaseUrl: string = 'http://localhost:11434'
  ): void {
    const db = this.getDB();
    const now = Math.floor(Date.now() / 1000);
    // Encrypt API keys before storing
    const encryptedKeys = apiKeys ? encryptApiKeys(apiKeys) : null;
    const apiKeysJson = encryptedKeys ? JSON.stringify(encryptedKeys) : null;

    db.prepare(`
      INSERT INTO ai_config (wallet_address, default_provider, default_model, api_keys, ollama_base_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        default_provider = excluded.default_provider,
        default_model = excluded.default_model,
        api_keys = excluded.api_keys,
        ollama_base_url = excluded.ollama_base_url,
        updated_at = excluded.updated_at
    `).run(walletAddress, defaultProvider, defaultModel, apiKeysJson, ollamaBaseUrl, now);
  }

  /**
   * Update API keys for a wallet (merge with existing)
   */
  updateAIAPIKeys(walletAddress: string, apiKeys: Record<string, string>): void {
    const db = this.getDB();
    const existing = this.getAIConfigRaw(walletAddress);
    
    // Merge with existing encrypted keys
    let mergedKeys: Record<string, string> = {};
    if (existing?.api_keys) {
      try {
        mergedKeys = JSON.parse(existing.api_keys);
      } catch (e) {
        // If parsing fails, start fresh
      }
    }
    
    // Encrypt new keys and merge
    const encryptedNewKeys = encryptApiKeys(apiKeys);
    Object.assign(mergedKeys, encryptedNewKeys);
    
    // Update config
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO ai_config (wallet_address, default_provider, default_model, api_keys, ollama_base_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        api_keys = excluded.api_keys,
        updated_at = excluded.updated_at
    `).run(
      walletAddress,
      existing?.default_provider || 'ollama',
      existing?.default_model || null,
      JSON.stringify(mergedKeys),
      existing?.ollama_base_url || 'http://localhost:11434',
      now
    );
  }

  /**
   * Delete API key for a specific provider
   */
  deleteAIAPIKey(walletAddress: string, provider: string): void {
    const db = this.getDB();
    const existing = this.getAIConfigRaw(walletAddress);
    
    if (!existing?.api_keys) {
      return; // No keys to delete
    }
    
    try {
      // Work with encrypted keys directly
      const keys = JSON.parse(existing.api_keys);
      delete keys[provider];
      
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE ai_config 
        SET api_keys = ?, updated_at = ?
        WHERE wallet_address = ?
      `).run(JSON.stringify(keys), now, walletAddress);
    } catch (e) {
      // If parsing fails, ignore
    }
  }

  // ============================================================================
  // Recent Apps Operations
  // ============================================================================

  /**
   * Record a recent app launch (upsert - update launched_at if exists)
   */
  recordRecentApp(walletAddress: string, appName: string): void {
    const db = this.getDB();
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO recent_apps (wallet_address, app_name, launched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(wallet_address, app_name) DO UPDATE SET
        launched_at = excluded.launched_at
    `).run(walletAddress, appName, now);
  }

  /**
   * Get recent apps for a user, ordered by most recent first
   */
  getRecentApps(walletAddress: string, limit: number = 10): string[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT app_name
      FROM recent_apps
      WHERE wallet_address = ?
      ORDER BY launched_at DESC
      LIMIT ?
    `).all(walletAddress, limit) as Array<{ app_name: string }>;
    
    return rows.map(row => row.app_name);
  }

  // ============================================================================
  // API Key Operations
  // ============================================================================

  /**
   * Create a new API key
   */
  createApiKey(keyId: string, keyHash: string, walletAddress: string, name: string, scopes: string, expiresAt?: number): void {
    const db = this.getDB();
    const now = Date.now();
    
    db.prepare(`
      INSERT INTO api_keys (key_id, key_hash, wallet_address, name, scopes, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(keyId, keyHash, walletAddress, name, scopes, now, expiresAt || null);
  }

  /**
   * Get API key by hash (for authentication)
   */
  getApiKeyByHash(keyHash: string): { key_id: string; wallet_address: string; name: string; scopes: string; expires_at: number | null; revoked: number } | null {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT key_id, wallet_address, name, scopes, expires_at, revoked
      FROM api_keys
      WHERE key_hash = ? AND revoked = 0
    `).get(keyHash) as any;
    
    return row || null;
  }

  /**
   * Update last used timestamp for API key
   */
  updateApiKeyLastUsed(keyId: string): void {
    const db = this.getDB();
    db.prepare(`
      UPDATE api_keys SET last_used_at = ? WHERE key_id = ?
    `).run(Date.now(), keyId);
  }

  /**
   * List API keys for a user
   */
  listApiKeys(walletAddress: string): Array<{ key_id: string; name: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null; revoked: number }> {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT key_id, name, scopes, created_at, expires_at, last_used_at, revoked
      FROM api_keys
      WHERE wallet_address = ?
      ORDER BY created_at DESC
    `).all(walletAddress) as any[];
    
    return rows;
  }

  /**
   * Revoke an API key
   */
  revokeApiKey(keyId: string, walletAddress: string): boolean {
    const db = this.getDB();
    const result = db.prepare(`
      UPDATE api_keys SET revoked = 1 WHERE key_id = ? AND wallet_address = ?
    `).run(keyId, walletAddress);
    
    return result.changes > 0;
  }

  /**
   * Delete an API key
   */
  deleteApiKey(keyId: string, walletAddress: string): boolean {
    const db = this.getDB();
    const result = db.prepare(`
      DELETE FROM api_keys WHERE key_id = ? AND wallet_address = ?
    `).run(keyId, walletAddress);
    
    return result.changes > 0;
  }

  // ============================================================================
  // Audit Log Methods
  // ============================================================================

  /**
   * Create an audit log entry
   */
  createAuditLog(entry: {
    wallet_address: string;
    action: string;
    resource?: string;
    resource_path?: string;
    method: string;
    endpoint: string;
    status_code?: number;
    request_body?: string | null;
    response_summary?: string | null;
    ip_address?: string;
    user_agent?: string;
    api_key_id?: string;
    duration_ms?: number;
    created_at: number;
  }): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO audit_logs (
        wallet_address, action, resource, resource_path, method, endpoint,
        status_code, request_body, response_summary, ip_address, user_agent,
        api_key_id, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.wallet_address,
      entry.action,
      entry.resource || null,
      entry.resource_path || null,
      entry.method,
      entry.endpoint,
      entry.status_code || null,
      entry.request_body || null,
      entry.response_summary || null,
      entry.ip_address || null,
      entry.user_agent || null,
      entry.api_key_id || null,
      entry.duration_ms || null,
      entry.created_at
    );
  }

  /**
   * Get audit logs for a user
   */
  getAuditLogs(
    walletAddress: string,
    options: {
      limit?: number;
      offset?: number;
      action?: string;
      since?: number;
      until?: number;
    } = {}
  ): Array<{
    id: number;
    action: string;
    resource: string | null;
    resource_path: string | null;
    method: string;
    endpoint: string;
    status_code: number | null;
    request_body: string | null;
    response_summary: string | null;
    ip_address: string | null;
    user_agent: string | null;
    api_key_id: string | null;
    duration_ms: number | null;
    created_at: number;
  }> {
    const db = this.getDB();
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    
    let query = `
      SELECT id, action, resource, resource_path, method, endpoint,
        status_code, request_body, response_summary, ip_address, user_agent,
        api_key_id, duration_ms, created_at
      FROM audit_logs
      WHERE wallet_address = ?
    `;
    const params: any[] = [walletAddress];

    if (options.action) {
      query += ' AND action = ?';
      params.push(options.action);
    }
    if (options.since) {
      query += ' AND created_at >= ?';
      params.push(options.since);
    }
    if (options.until) {
      query += ' AND created_at <= ?';
      params.push(options.until);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params) as any[];
  }

  /**
   * Get audit log count for a user
   */
  getAuditLogsCount(
    walletAddress: string,
    options: {
      action?: string;
      since?: number;
      until?: number;
    } = {}
  ): number {
    const db = this.getDB();
    
    let query = 'SELECT COUNT(*) as count FROM audit_logs WHERE wallet_address = ?';
    const params: any[] = [walletAddress];

    if (options.action) {
      query += ' AND action = ?';
      params.push(options.action);
    }
    if (options.since) {
      query += ' AND created_at >= ?';
      params.push(options.since);
    }
    if (options.until) {
      query += ' AND created_at <= ?';
      params.push(options.until);
    }

    const result = db.prepare(query).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Get audit stats for a user
   */
  getAuditStats(
    walletAddress: string,
    since: number
  ): {
    total_actions: number;
    actions_by_type: Record<string, number>;
    average_duration_ms: number;
    success_rate: number;
  } {
    const db = this.getDB();
    
    // Total actions
    const totalResult = db.prepare(`
      SELECT COUNT(*) as count FROM audit_logs
      WHERE wallet_address = ? AND created_at >= ?
    `).get(walletAddress, since) as { count: number };

    // Actions by type
    const actionResults = db.prepare(`
      SELECT action, COUNT(*) as count FROM audit_logs
      WHERE wallet_address = ? AND created_at >= ?
      GROUP BY action ORDER BY count DESC
    `).all(walletAddress, since) as Array<{ action: string; count: number }>;

    const actionsByType: Record<string, number> = {};
    for (const row of actionResults) {
      actionsByType[row.action] = row.count;
    }

    // Average duration
    const durationResult = db.prepare(`
      SELECT AVG(duration_ms) as avg FROM audit_logs
      WHERE wallet_address = ? AND created_at >= ? AND duration_ms IS NOT NULL
    `).get(walletAddress, since) as { avg: number | null };

    // Success rate (status 2xx or response_summary contains 'success')
    const successResult = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN (status_code >= 200 AND status_code < 300) OR response_summary LIKE '%success%' THEN 1 ELSE 0 END) as success
      FROM audit_logs
      WHERE wallet_address = ? AND created_at >= ?
    `).get(walletAddress, since) as { total: number; success: number };

    return {
      total_actions: totalResult.count,
      actions_by_type: actionsByType,
      average_duration_ms: Math.round(durationResult.avg || 0),
      success_rate: successResult.total > 0 ? (successResult.success / successResult.total) * 100 : 100,
    };
  }

  // ============================================================================
  // File Search Operations (Wallet-Scoped)
  // ============================================================================

  /**
   * Search files using FTS5 full-text search
   * Returns files matching the query, scoped to the wallet
   */
  searchFiles(
    walletAddress: string,
    query: string,
    limit: number = 10
  ): Array<{
    path: string;
    content_text: string | null;
    mime_type: string | null;
    updated_at: number;
  }> {
    const db = this.getDB();
    
    try {
      // Use FTS5 search with wallet scope
      const results = db.prepare(`
        SELECT f.path, f.content_text, f.mime_type, f.updated_at
        FROM files f
        JOIN files_fts fts ON f.rowid = fts.rowid
        WHERE fts.content MATCH ?
          AND f.wallet_address = ?
          AND f.is_dir = 0
        ORDER BY fts.rank
        LIMIT ?
      `).all(query, walletAddress, limit) as any[];
      
      return results;
    } catch (error: any) {
      // FTS might not be available or query might be invalid
      // Fall back to LIKE search
      const likeQuery = `%${query}%`;
      const results = db.prepare(`
        SELECT path, content_text, mime_type, updated_at
        FROM files
        WHERE wallet_address = ?
          AND is_dir = 0
          AND (path LIKE ? OR content_text LIKE ?)
        LIMIT ?
      `).all(walletAddress, likeQuery, likeQuery, limit) as any[];
      
      return results;
    }
  }

  // ============================================================================
  // AI Memory State Operations (Wallet-Scoped)
  // ============================================================================

  /**
   * Get AI memory state for a wallet
   * Used by MemoryConsolidator for context optimization
   */
  getMemoryState(walletAddress: string): {
    consolidated_summary: string;
    entities_json: string;
    last_actions_json: string;
    user_intent: string;
    message_count: number;
    updated_at: number;
  } | null {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT consolidated_summary, entities_json, last_actions_json, user_intent, message_count, updated_at
      FROM ai_memory_state
      WHERE wallet_address = ?
    `).get(walletAddress) as any;
    
    return row || null;
  }

  /**
   * Save AI memory state for a wallet
   */
  saveMemoryState(
    walletAddress: string,
    state: {
      consolidated_summary: string;
      entities_json: string;
      last_actions_json: string;
      user_intent: string;
      message_count: number;
      updated_at: number;
    }
  ): void {
    const db = this.getDB();
    
    db.prepare(`
      INSERT INTO ai_memory_state (wallet_address, consolidated_summary, entities_json, last_actions_json, user_intent, message_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet_address) DO UPDATE SET
        consolidated_summary = excluded.consolidated_summary,
        entities_json = excluded.entities_json,
        last_actions_json = excluded.last_actions_json,
        user_intent = excluded.user_intent,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run(
      walletAddress,
      state.consolidated_summary,
      state.entities_json,
      state.last_actions_json,
      state.user_intent,
      state.message_count,
      state.updated_at
    );
  }

  /**
   * Clear AI memory state for a wallet (e.g., when starting new conversation)
   */
  clearMemoryState(walletAddress: string): void {
    const db = this.getDB();
    db.prepare('DELETE FROM ai_memory_state WHERE wallet_address = ?').run(walletAddress);
  }

  // ============================================================================
  // AI CONVERSATIONS (Persistent Chat History)
  // ============================================================================

  /**
   * Get all conversations for a wallet (ordered by most recent first)
   */
  getConversations(walletAddress: string): AIConversation[] {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT id, wallet_address, title, messages_json, created_at, updated_at
      FROM ai_conversations
      WHERE wallet_address = ?
      ORDER BY updated_at DESC
    `).all(walletAddress) as AIConversation[];
    return rows;
  }

  /**
   * Get a single conversation by ID (with wallet validation)
   */
  getConversation(walletAddress: string, conversationId: string): AIConversation | null {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT id, wallet_address, title, messages_json, created_at, updated_at
      FROM ai_conversations
      WHERE wallet_address = ? AND id = ?
    `).get(walletAddress, conversationId) as AIConversation | undefined;
    return row ?? null;
  }

  /**
   * Create a new conversation
   */
  createConversation(
    walletAddress: string,
    conversationId: string,
    title: string = 'New Conversation',
    messages: any[] = []
  ): AIConversation {
    const db = this.getDB();
    const now = Math.floor(Date.now() / 1000);
    const messagesJson = JSON.stringify(messages);

    db.prepare(`
      INSERT INTO ai_conversations (id, wallet_address, title, messages_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversationId, walletAddress, title, messagesJson, now, now);

    return {
      id: conversationId,
      wallet_address: walletAddress,
      title,
      messages_json: messagesJson,
      created_at: now,
      updated_at: now
    };
  }

  /**
   * Update a conversation (messages and/or title)
   */
  updateConversation(
    walletAddress: string,
    conversationId: string,
    updates: { title?: string; messages?: any[] }
  ): boolean {
    const db = this.getDB();
    const now = Math.floor(Date.now() / 1000);

    // Build dynamic update query
    const setClauses: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }

    if (updates.messages !== undefined) {
      setClauses.push('messages_json = ?');
      values.push(JSON.stringify(updates.messages));
    }

    values.push(walletAddress, conversationId);

    const result = db.prepare(`
      UPDATE ai_conversations
      SET ${setClauses.join(', ')}
      WHERE wallet_address = ? AND id = ?
    `).run(...values);

    return result.changes > 0;
  }

  /**
   * Delete a conversation
   */
  deleteConversation(walletAddress: string, conversationId: string): boolean {
    const db = this.getDB();
    const result = db.prepare(`
      DELETE FROM ai_conversations
      WHERE wallet_address = ? AND id = ?
    `).run(walletAddress, conversationId);
    return result.changes > 0;
  }

  /**
   * Delete all conversations for a wallet
   */
  deleteAllConversations(walletAddress: string): number {
    const db = this.getDB();
    const result = db.prepare(`
      DELETE FROM ai_conversations
      WHERE wallet_address = ?
    `).run(walletAddress);
    return result.changes;
  }

  // ============================================================================
  // Agent Proposal Operations
  // ============================================================================

  /**
   * Save an agent proposal to the database
   */
  saveProposal(proposal: {
    id: string;
    walletAddress: string;
    type: string;
    status: string;
    from?: string;
    smartAccountAddress?: string;
    recipient?: string;
    to?: string;
    value?: string;
    data?: string;
    chainId?: number;
    token?: {
      address?: string | null;
      symbol?: string;
      decimals?: number;
      amount?: string;
    };
    summary?: {
      action?: string;
      estimatedGas?: string;
      totalCost?: string;
    };
    txHash?: string;
    error?: string;
    rejectionReason?: string;
    createdAt: number;
    expiresAt?: number;
    approvedAt?: number;
    rejectedAt?: number;
    executedAt?: number;
  }): void {
    const db = this.getDB();
    
    db.prepare(`
      INSERT INTO agent_proposals (
        id, wallet_address, type, status, from_address, smart_account_address,
        recipient, to_address, value, data, chain_id,
        token_address, token_symbol, token_decimals, token_amount,
        summary_action, summary_estimated_gas, summary_total_cost,
        tx_hash, error, rejection_reason,
        created_at, expires_at, approved_at, rejected_at, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        tx_hash = excluded.tx_hash,
        error = excluded.error,
        rejection_reason = excluded.rejection_reason,
        approved_at = excluded.approved_at,
        rejected_at = excluded.rejected_at,
        executed_at = excluded.executed_at
    `).run(
      proposal.id,
      proposal.walletAddress,
      proposal.type,
      proposal.status,
      proposal.from || null,
      proposal.smartAccountAddress || null,
      proposal.recipient || null,
      proposal.to || null,
      proposal.value || null,
      proposal.data || null,
      proposal.chainId || null,
      proposal.token?.address || null,
      proposal.token?.symbol || null,
      proposal.token?.decimals || null,
      proposal.token?.amount || null,
      proposal.summary?.action || null,
      proposal.summary?.estimatedGas || null,
      proposal.summary?.totalCost || null,
      proposal.txHash || null,
      proposal.error || null,
      proposal.rejectionReason || null,
      proposal.createdAt,
      proposal.expiresAt || null,
      proposal.approvedAt || null,
      proposal.rejectedAt || null,
      proposal.executedAt || null
    );
  }

  /**
   * Get proposals for a wallet
   */
  getProposals(walletAddress: string, limit = 50): any[] {
    const db = this.getDB();
    
    const rows = db.prepare(`
      SELECT * FROM agent_proposals
      WHERE wallet_address = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(walletAddress, limit) as any[];
    
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      status: row.status,
      from: row.from_address,
      smartAccountAddress: row.smart_account_address,
      recipient: row.recipient,
      to: row.to_address,
      value: row.value,
      data: row.data,
      chainId: row.chain_id,
      token: row.token_symbol ? {
        address: row.token_address,
        symbol: row.token_symbol,
        decimals: row.token_decimals,
        amount: row.token_amount,
      } : undefined,
      summary: row.summary_action ? {
        action: row.summary_action,
        estimatedGas: row.summary_estimated_gas,
        totalCost: row.summary_total_cost,
      } : undefined,
      txHash: row.tx_hash,
      error: row.error,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      executedAt: row.executed_at,
    }));
  }

  /**
   * Update proposal status
   */
  updateProposalStatus(
    proposalId: string,
    status: string,
    extra?: { txHash?: string; error?: string; rejectionReason?: string }
  ): boolean {
    const db = this.getDB();
    const now = Date.now();
    
    let timestampField = '';
    if (status === 'approved') timestampField = 'approved_at = ?,';
    else if (status === 'rejected') timestampField = 'rejected_at = ?,';
    else if (status === 'executed') timestampField = 'executed_at = ?,';
    
    const sql = `
      UPDATE agent_proposals SET
        status = ?,
        ${timestampField}
        tx_hash = COALESCE(?, tx_hash),
        error = COALESCE(?, error),
        rejection_reason = COALESCE(?, rejection_reason)
      WHERE id = ?
    `;
    
    const params = timestampField 
      ? [status, now, extra?.txHash || null, extra?.error || null, extra?.rejectionReason || null, proposalId]
      : [status, extra?.txHash || null, extra?.error || null, extra?.rejectionReason || null, proposalId];
    
    const result = db.prepare(sql).run(...params);
    return result.changes > 0;
  }

  /**
   * Get proposal by ID
   */
  getProposal(proposalId: string): any | null {
    const db = this.getDB();
    
    const row = db.prepare(`
      SELECT * FROM agent_proposals WHERE id = ?
    `).get(proposalId) as any;
    
    if (!row) return null;
    
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      from: row.from_address,
      smartAccountAddress: row.smart_account_address,
      recipient: row.recipient,
      to: row.to_address,
      value: row.value,
      data: row.data,
      chainId: row.chain_id,
      token: row.token_symbol ? {
        address: row.token_address,
        symbol: row.token_symbol,
        decimals: row.token_decimals,
        amount: row.token_amount,
      } : undefined,
      summary: row.summary_action ? {
        action: row.summary_action,
        estimatedGas: row.summary_estimated_gas,
        totalCost: row.summary_total_cost,
      } : undefined,
      txHash: row.tx_hash,
      error: row.error,
      rejectionReason: row.rejection_reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      executedAt: row.executed_at,
    };
  }

  // ── Installed Apps ────────────────────────────────────────

  getInstalledApp(appName: string): InstalledApp | undefined {
    const db = this.getDB();
    return db.prepare('SELECT * FROM installed_apps WHERE app_name = ?').get(appName) as InstalledApp | undefined;
  }

  listInstalledApps(): InstalledApp[] {
    const db = this.getDB();
    return db.prepare('SELECT * FROM installed_apps ORDER BY installed_at DESC').all() as InstalledApp[];
  }

  registerInstalledApp(app: InstalledApp): void {
    const db = this.getDB();
    db.prepare(`
      INSERT OR REPLACE INTO installed_apps
        (app_name, title, version, cid, size, icon, description, author,
         permissions_json, requirements_json, manifest_json, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      app.app_name, app.title, app.version, app.cid, app.size,
      app.icon, app.description, app.author,
      app.permissions_json, app.requirements_json, app.manifest_json,
      app.installed_at, app.updated_at
    );
  }

  uninstallApp(appName: string): boolean {
    const db = this.getDB();
    const result = db.prepare('DELETE FROM installed_apps WHERE app_name = ?').run(appName);
    return result.changes > 0;
  }

  // ── Content Catalog (On-Chain Indexer) ──────────────────────

  upsertCatalogItem(item: ContentCatalogItem): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO content_catalog
        (content_id, channel_address, token_id, operative_address, creator_address,
         name, description, image_url, content_cid, metadata_cid, mime_type,
         asset_type, price, payment_token, op_type, chain_id, block_number,
         tx_hash, contract_version, metadata_status, indexed_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_address, token_id, chain_id) DO UPDATE SET
        content_id = COALESCE(excluded.content_id, content_id),
        operative_address = COALESCE(excluded.operative_address, operative_address),
        name = COALESCE(excluded.name, name),
        description = COALESCE(excluded.description, description),
        image_url = COALESCE(excluded.image_url, image_url),
        content_cid = COALESCE(excluded.content_cid, content_cid),
        metadata_cid = COALESCE(excluded.metadata_cid, metadata_cid),
        mime_type = COALESCE(excluded.mime_type, mime_type),
        asset_type = COALESCE(excluded.asset_type, asset_type),
        price = COALESCE(excluded.price, price),
        payment_token = COALESCE(excluded.payment_token, payment_token),
        metadata_status = excluded.metadata_status,
        metadata_json = COALESCE(excluded.metadata_json, metadata_json)
    `).run(
      item.content_id, item.channel_address, item.token_id, item.operative_address,
      item.creator_address, item.name, item.description, item.image_url,
      item.content_cid, item.metadata_cid, item.mime_type, item.asset_type,
      item.price, item.payment_token, item.op_type, item.chain_id,
      item.block_number, item.tx_hash, item.contract_version,
      item.metadata_status, item.indexed_at, item.metadata_json
    );
  }

  getCatalogItemsPendingMetadata(limit = 50): ContentCatalogItem[] {
    const db = this.getDB();
    return db.prepare(`
      SELECT * FROM content_catalog
      WHERE metadata_status = 'pending'
      ORDER BY block_number ASC
      LIMIT ?
    `).all(limit) as ContentCatalogItem[];
  }

  updateCatalogMetadata(channelAddress: string, tokenId: number, chainId: number, updates: Partial<ContentCatalogItem>): void {
    const db = this.getDB();
    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && key !== 'channel_address' && key !== 'token_id' && key !== 'chain_id') {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    values.push(channelAddress, tokenId, chainId);
    db.prepare(`
      UPDATE content_catalog SET ${fields.join(', ')}
      WHERE channel_address = ? AND token_id = ? AND chain_id = ?
    `).run(...values);
  }

  catalogItemExists(channelAddress: string, tokenId: number, chainId: number): boolean {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT 1 FROM content_catalog
      WHERE channel_address = ? AND token_id = ? AND chain_id = ?
    `).get(channelAddress, tokenId, chainId);
    return !!row;
  }

  getCatalogItems(options: {
    assetType?: string;
    creator?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): { items: ContentCatalogItem[]; total: number } {
    const db = this.getDB();
    const conditions: string[] = ["metadata_status = 'resolved'"];
    const params: any[] = [];

    if (options.assetType) {
      conditions.push('asset_type = ?');
      params.push(options.assetType);
    }
    if (options.creator) {
      conditions.push('creator_address = ?');
      params.push(options.creator);
    }
    if (options.search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${options.search}%`, `%${options.search}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM content_catalog ${where}`).get(...params) as { total: number };

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    const items = db.prepare(`
      SELECT * FROM content_catalog ${where}
      ORDER BY block_number DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ContentCatalogItem[];

    return { items, total: countRow.total };
  }

  getCatalogItemByContentId(contentId: string): ContentCatalogItem | undefined {
    const db = this.getDB();
    return db.prepare(`
      SELECT * FROM content_catalog WHERE content_id = ?
    `).get(contentId) as ContentCatalogItem | undefined;
  }

  getCreatorEarningsLocal(creatorAddress: string): {
    assets: Array<{
      name: string | null;
      content_cid: string | null;
      asset_type: string | null;
      price: string | null;
      channel_address: string;
      token_id: number;
      serve_count: number;
      bytes_served: number;
      last_served_at: number | null;
      is_pinned_locally: boolean;
    }>;
    totals: { assets: number; totalServes: number; totalBytesServed: number; locallyPinned: number };
  } {
    const db = this.getDB();
    const rows = db.prepare(`
      SELECT
        c.name, c.content_cid, c.asset_type, c.price,
        c.channel_address, c.token_id,
        COALESCE(p.serve_count, 0) as serve_count,
        COALESCE(p.size, 0) as bytes_served,
        p.last_served_at,
        CASE WHEN p.pin_status = 'complete' THEN 1 ELSE 0 END as is_pinned
      FROM content_catalog c
      LEFT JOIN pinned_cids p ON c.content_cid = p.cid
      WHERE c.creator_address = ? AND c.metadata_status = 'resolved'
      ORDER BY COALESCE(p.serve_count, 0) DESC
    `).all(creatorAddress.toLowerCase()) as any[];

    let totalServes = 0;
    let totalBytes = 0;
    let pinned = 0;

    const assets = rows.map(r => {
      totalServes += r.serve_count;
      totalBytes += r.bytes_served;
      if (r.is_pinned) pinned++;
      return {
        name: r.name,
        content_cid: r.content_cid,
        asset_type: r.asset_type,
        price: r.price,
        channel_address: r.channel_address,
        token_id: r.token_id,
        serve_count: r.serve_count,
        bytes_served: r.bytes_served,
        last_served_at: r.last_served_at,
        is_pinned_locally: !!r.is_pinned,
      };
    });

    return {
      assets,
      totals: { assets: assets.length, totalServes, totalBytesServed: totalBytes, locallyPinned: pinned },
    };
  }

  getNodeSeedingStats(): {
    totalPinnedCIDs: number;
    totalBytesSeeded: number;
    totalServes: number;
    topServed: Array<{ cid: string; serve_count: number; size: number; last_served_at: number | null }>;
  } {
    const db = this.getDB();
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(size), 0) as bytes,
        COALESCE(SUM(serve_count), 0) as serves
      FROM pinned_cids WHERE pin_status = 'complete'
    `).get() as any;

    const top = db.prepare(`
      SELECT cid, serve_count, size, last_served_at
      FROM pinned_cids
      WHERE pin_status = 'complete' AND serve_count > 0
      ORDER BY serve_count DESC
      LIMIT 20
    `).all() as any[];

    return {
      totalPinnedCIDs: summary.total,
      totalBytesSeeded: summary.bytes,
      totalServes: summary.serves,
      topServed: top,
    };
  }

  getCatalogStats(): { total: number; resolved: number; pending: number; failed: number; byType: Record<string, number> } {
    const db = this.getDB();
    const total = (db.prepare('SELECT COUNT(*) as c FROM content_catalog').get() as any).c;
    const resolved = (db.prepare("SELECT COUNT(*) as c FROM content_catalog WHERE metadata_status = 'resolved'").get() as any).c;
    const pending = (db.prepare("SELECT COUNT(*) as c FROM content_catalog WHERE metadata_status = 'pending'").get() as any).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM content_catalog WHERE metadata_status = 'failed'").get() as any).c;
    const typeRows = db.prepare("SELECT asset_type, COUNT(*) as c FROM content_catalog WHERE metadata_status = 'resolved' AND asset_type IS NOT NULL GROUP BY asset_type").all() as any[];
    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.asset_type] = row.c;
    }
    return { total, resolved, pending, failed, byType };
  }

  getCreatorStats(creatorAddress: string): {
    totalAssets: number;
    byType: Record<string, number>;
    locallyPinned: number;
    totalServes: number;
    totalBytesServed: number;
    assets: Array<{
      name: string | null;
      content_cid: string | null;
      asset_type: string | null;
      channel_address: string;
      token_id: number;
      serve_count: number;
      size: number;
      last_served_at: number | null;
    }>;
  } {
    const db = this.getDB();
    const addr = creatorAddress.toLowerCase();

    const assets = db.prepare(`
      SELECT c.name, c.content_cid, c.asset_type, c.channel_address, c.token_id,
             COALESCE(p.serve_count, 0) as serve_count,
             COALESCE(p.size, 0) as size,
             p.last_served_at
      FROM content_catalog c
      LEFT JOIN pinned_cids p ON c.content_cid = p.cid
      WHERE LOWER(c.creator_address) = ?
        AND c.metadata_status = 'resolved'
      ORDER BY COALESCE(p.serve_count, 0) DESC
    `).all(addr) as any[];

    const byType: Record<string, number> = {};
    let locallyPinned = 0;
    let totalServes = 0;
    let totalBytesServed = 0;

    for (const a of assets) {
      const t = a.asset_type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
      if (a.serve_count > 0) locallyPinned++;
      totalServes += a.serve_count;
      totalBytesServed += a.size * a.serve_count;
    }

    return {
      totalAssets: assets.length,
      byType,
      locallyPinned,
      totalServes,
      totalBytesServed,
      assets,
    };
  }

  // ── Content Hash Registry (perceptual fingerprinting) ───────────────────

  insertContentHash(record: {
    phash: string;
    algorithm?: string;
    token_id?: string;
    channel?: string;
    creator?: string;
    content_type?: string;
    metadata_cid?: string;
    source?: string;
  }): number {
    const db = this.getDB();
    const result = db.prepare(`
      INSERT INTO content_hashes (phash, algorithm, token_id, channel, creator, content_type, metadata_cid, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.phash,
      record.algorithm || 'phash',
      record.token_id || null,
      record.channel || null,
      record.creator ? record.creator.toLowerCase() : null,
      record.content_type || null,
      record.metadata_cid || null,
      record.source || 'local',
    );
    return result.lastInsertRowid as number;
  }

  findSimilarHashes(phash: string, algorithm: string = 'phash'): Array<{
    id: number;
    phash: string;
    token_id: string | null;
    channel: string | null;
    creator: string | null;
    content_type: string | null;
    created_at: string;
    source: string;
  }> {
    const db = this.getDB();
    return db.prepare(`
      SELECT id, phash, token_id, channel, creator, content_type, created_at, source
      FROM content_hashes
      WHERE algorithm = ?
      ORDER BY created_at DESC
    `).all(algorithm) as any[];
  }

  getHashesByCreator(creator: string): Array<{
    id: number;
    phash: string;
    algorithm: string;
    token_id: string | null;
    channel: string | null;
    content_type: string | null;
    created_at: string;
  }> {
    const db = this.getDB();
    return db.prepare(`
      SELECT id, phash, algorithm, token_id, channel, content_type, created_at
      FROM content_hashes
      WHERE creator = ?
      ORDER BY created_at DESC
    `).all(creator.toLowerCase()) as any[];
  }

  getHashByTokenId(tokenId: string): {
    id: number;
    phash: string;
    algorithm: string;
    channel: string | null;
    creator: string | null;
    content_type: string | null;
    created_at: string;
    source: string;
  } | undefined {
    const db = this.getDB();
    return db.prepare(`
      SELECT id, phash, algorithm, channel, creator, content_type, created_at, source
      FROM content_hashes
      WHERE token_id = ?
    `).get(tokenId) as any;
  }

  getContentHashStats(): { total: number; byAlgorithm: Record<string, number>; bySource: Record<string, number> } {
    const db = this.getDB();
    const total = (db.prepare('SELECT COUNT(*) as c FROM content_hashes').get() as any).c;
    const algoRows = db.prepare('SELECT algorithm, COUNT(*) as c FROM content_hashes GROUP BY algorithm').all() as any[];
    const sourceRows = db.prepare('SELECT source, COUNT(*) as c FROM content_hashes GROUP BY source').all() as any[];
    const byAlgorithm: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const r of algoRows) byAlgorithm[r.algorithm] = r.c;
    for (const r of sourceRows) bySource[r.source] = r.c;
    return { total, byAlgorithm, bySource };
  }

  // ── Publish Drafts (queue / sign-later) ─────────────────────────────

  insertDraft(record: {
    wallet_address: string;
    title: string;
    description?: string;
    category?: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
    asset_cid: string;
    metadata_cid: string;
    encrypt_hash: string;
    channel: string;
    price?: string;
    currency_address?: string;
    currency_symbol?: string;
    copies?: number;
    access_method?: string;
    reseller_cut?: number;
    royalty_partners?: string;
    thumbnail_cid?: string;
    adult?: boolean;
    steps?: string;
  }): number {
    const db = this.getDB();
    const result = db.prepare(`
      INSERT INTO publish_drafts (
        wallet_address, title, description, category, file_name, file_size, mime_type,
        asset_cid, metadata_cid, encrypt_hash, channel, price, currency_address,
        currency_symbol, copies, access_method, reseller_cut, royalty_partners,
        thumbnail_cid, adult, steps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.wallet_address.toLowerCase(),
      record.title,
      record.description || null,
      record.category || null,
      record.file_name || null,
      record.file_size || null,
      record.mime_type || null,
      record.asset_cid,
      record.metadata_cid,
      record.encrypt_hash,
      record.channel,
      record.price || null,
      record.currency_address || null,
      record.currency_symbol || null,
      record.copies || 1,
      record.access_method || 'buy_once',
      record.reseller_cut || 0,
      record.royalty_partners || null,
      record.thumbnail_cid || null,
      record.adult ? 1 : 0,
      record.steps || null,
    );
    return result.lastInsertRowid as number;
  }

  getDraftsByWallet(walletAddress: string): any[] {
    const db = this.getDB();
    return db.prepare(`
      SELECT * FROM publish_drafts
      WHERE wallet_address = ?
      ORDER BY created_at DESC
    `).all(walletAddress.toLowerCase());
  }

  getDraftById(id: number, walletAddress: string): any | undefined {
    const db = this.getDB();
    return db.prepare(`
      SELECT * FROM publish_drafts
      WHERE id = ? AND wallet_address = ?
    `).get(id, walletAddress.toLowerCase());
  }

  updateDraftStatus(id: number, walletAddress: string, status: string): boolean {
    const db = this.getDB();
    const result = db.prepare(`
      UPDATE publish_drafts
      SET status = ?, updated_at = datetime('now')
      WHERE id = ? AND wallet_address = ?
    `).run(status, id, walletAddress.toLowerCase());
    return result.changes > 0;
  }

  deleteDraft(id: number, walletAddress: string): boolean {
    const db = this.getDB();
    const result = db.prepare(`
      DELETE FROM publish_drafts
      WHERE id = ? AND wallet_address = ?
    `).run(id, walletAddress.toLowerCase());
    return result.changes > 0;
  }

  getDraftCount(walletAddress: string): number {
    const db = this.getDB();
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM publish_drafts
      WHERE wallet_address = ? AND status IN ('ready', 'processing')
    `).get(walletAddress.toLowerCase()) as any;
    return row?.c || 0;
  }

  // ============================================================================
  // Agent Audit Log Operations (AI action tracking — separate from API audit_logs)
  // ============================================================================

  insertAgentAuditLog(
    agentId: string,
    action: string,
    detail?: Record<string, unknown>,
    source?: string,
    sessionKey?: string
  ): void {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO agent_audit_log (agent_id, action, detail, source, session_key)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      agentId,
      action,
      detail ? JSON.stringify(detail) : null,
      source || null,
      sessionKey || null
    );
  }

  getAgentAuditLogs(options: {
    agentId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  } = {}): Array<Record<string, unknown>> {
    const db = this.getDB();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.agentId) {
      conditions.push('agent_id = ?');
      params.push(options.agentId);
    }
    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    return db.prepare(`
      SELECT * FROM agent_audit_log
      ${where}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<Record<string, unknown>>;
  }

  /**
   * Remove agent audit log entries older than retentionDays.
   * Returns number of rows deleted.
   */
  cleanupAgentAuditLogs(retentionDays = 30): number {
    const db = this.getDB();
    const result = db.prepare(`
      DELETE FROM agent_audit_log
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    return result.changes;
  }
}
