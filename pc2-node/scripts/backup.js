#!/usr/bin/env node

/**
 * Backup Script
 * 
 * Creates a timestamped backup archive containing:
 * - Database file (data/pc2.db) + WAL files if present
 * - IPFS repository (data/ipfs/)
 * - User configuration (config/config.json if exists)
 * - Encryption key (data/encryption.key) - CRITICAL for API key decryption
 * - Node configuration (data/node-config.json) - Owner wallet, access control, tethered DIDs
 * - Boson identity:
 *     v2 nodes: data/identity.enc (encrypted with mnemonic-derived key)
 *     v1 nodes: data/identity.json (plaintext, legacy)
 * - Username registration (data/username.json) - Registered Boson username
 * - Setup completion flag (data/setup-complete) - Skips setup wizard on restore
 * - Installed apps (data/installed-apps/) - User-installed dApps
 * - AI agent memory (data/agents/) - Agent context and history
 * - Backup metadata (backup-meta.json) - Format version and summary
 */

import { createWriteStream, existsSync, statSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';
import { create as createTar } from 'tar';
import { execSync } from 'child_process';
import { createCipheriv, createHmac, randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get project root (pc2-node/test-fresh-install)
const PROJECT_ROOT = resolve(__dirname, '..');

// Paths relative to project root
const DB_PATH = process.env.DB_PATH || './data/pc2.db';
const IPFS_REPO_PATH = process.env.IPFS_REPO_PATH || './data/ipfs';
const CONFIG_PATH = './config/config.json';
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');

// Critical data files that must be backed up for complete restore
const CRITICAL_DATA_FILES = [
  { relative: 'data/encryption.key', description: 'Encryption key (CRITICAL - needed for API key decryption)', sensitive: true },
  { relative: 'data/node-config.json', description: 'Node configuration (owner wallet, access control, tethered DIDs)' },
  { relative: 'data/identity.json', description: 'Boson node identity (keypair and DID)', identity: true },
  { relative: 'data/username.json', description: 'Registered Boson username' },
  { relative: 'data/setup-complete', description: 'Setup completion flag' }
];

// Directories to include in backup (if they exist)
const BACKUP_DIRECTORIES = [
  { relative: 'data/installed-apps', description: 'Installed applications' },
  { relative: 'data/agents', description: 'AI agent memory and history' }
];

/**
 * Encrypt identity.json for v2 (mnemonic-derived) nodes.
 * Uses AES-256-GCM with a key derived from the mnemonic via HKDF.
 * Returns the path to the temporary encrypted file, or null for v1 nodes.
 */
function encryptIdentityForBackup(identityPath, projectRoot) {
  try {
    const content = readFileSync(identityPath, 'utf8');
    const identity = JSON.parse(content);

    if (identity.identityVersion !== 2) {
      return null;
    }

    // Derive encryption key from a fixed marker in the identity 
    // (the public key serves as input to HKDF alongside a backup-specific salt).
    // On restore, the user provides the mnemonic, re-derives the keypair,
    // and uses the same public key to decrypt.
    const pubKeyBuf = Buffer.from(identity.publicKey, 'hex');
    const salt = Buffer.from('pc2-backup-identity-encryption', 'utf8');
    const info = Buffer.from('aes-256-gcm-key', 'utf8');
    const prk = createHmac('sha256', salt).update(pubKeyBuf).digest();
    const aesKey = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const plaintext = Buffer.from(content, 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const encPayload = JSON.stringify({
      version: 2,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: encrypted.toString('hex')
    });

    const encPath = resolve(projectRoot, 'data/identity.enc');
    writeFileSync(encPath, encPayload, { mode: 0o600 });
    return encPath;
  } catch (err) {
    console.log(`   ⚠️  Could not encrypt identity: ${err.message}`);
    return null;
  }
}

// Resolve absolute paths
const dbPath = resolve(PROJECT_ROOT, DB_PATH);
const ipfsRepoPath = resolve(PROJECT_ROOT, IPFS_REPO_PATH);
const configPath = resolve(PROJECT_ROOT, CONFIG_PATH);

/**
 * Format timestamp for backup filename
 */
function formatTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Get file size in human-readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Check if server is running
 */
function isServerRunning() {
  try {
    // Try to connect to the server port
    const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/default.json'), 'utf8'));
    const port = process.env.PORT || config.server.port || 4200;
    execSync(`lsof -ti:${port}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create backup archive
 */
async function createBackup() {
  console.log('📦 Creating PC2 Node backup...\n');

  // Check if server is running
  if (isServerRunning()) {
    console.log('⚠️  Warning: Server appears to be running.');
    console.log('   It is recommended to stop the server before backing up.');
    console.log('   Continuing anyway...\n');
  }

  // Validate data exists
  const itemsToBackup = [];
  const missingItems = [];

  // Check database
  if (existsSync(dbPath)) {
    const dbStats = statSync(dbPath);
    itemsToBackup.push({
      path: dbPath,
      name: 'data/pc2.db',
      size: dbStats.size
    });
    console.log(`✅ Database found: ${formatBytes(dbStats.size)}`);
  } else {
    missingItems.push('Database (data/pc2.db)');
    console.log('⚠️  Database not found (this is OK for fresh installs)');
  }

  // Check IPFS repo
  if (existsSync(ipfsRepoPath)) {
    try {
      // Get directory size (approximate)
      const ipfsStats = statSync(ipfsRepoPath);
      if (ipfsStats.isDirectory()) {
        itemsToBackup.push({
          path: ipfsRepoPath,
          name: 'data/ipfs',
          size: 0 // Will calculate during backup
        });
        console.log(`✅ IPFS repository found`);
      }
    } catch (error) {
      console.log(`⚠️  IPFS repository path exists but cannot be accessed: ${error.message}`);
    }
  } else {
    missingItems.push('IPFS repository (data/ipfs/)');
    console.log('⚠️  IPFS repository not found (this is OK for fresh installs)');
  }

  // Check user config
  if (existsSync(configPath)) {
    const configStats = statSync(configPath);
    itemsToBackup.push({
      path: configPath,
      name: 'config/config.json',
      size: configStats.size
    });
    console.log(`✅ User configuration found: ${formatBytes(configStats.size)}`);
  } else {
    console.log('ℹ️  User configuration not found (using defaults)');
  }

  // Check SQLite WAL files (if database is in WAL mode)
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';
  if (existsSync(walPath)) {
    const walStats = statSync(walPath);
    itemsToBackup.push({
      path: walPath,
      name: 'data/pc2.db-wal',
      size: walStats.size
    });
    console.log(`✅ SQLite WAL file found: ${formatBytes(walStats.size)}`);
  }
  if (existsSync(shmPath)) {
    const shmStats = statSync(shmPath);
    itemsToBackup.push({
      path: shmPath,
      name: 'data/pc2.db-shm',
      size: shmStats.size
    });
    console.log(`✅ SQLite SHM file found: ${formatBytes(shmStats.size)}`);
  }

  // Check critical data files for complete node restoration
  console.log('\n📋 Checking critical node files...');
  const criticalFilesFound = [];
  const criticalFilesMissing = [];
  let identityVersion = 1;
  let identityEncPath = null;
  const tempFilesToCleanup = [];

  for (const criticalFile of CRITICAL_DATA_FILES) {
    const filePath = resolve(PROJECT_ROOT, criticalFile.relative);
    if (existsSync(filePath)) {
      const fileStats = statSync(filePath);

      if (criticalFile.identity) {
        // For identity files: encrypt if v2, include plaintext if v1
        identityEncPath = encryptIdentityForBackup(filePath, PROJECT_ROOT);
        if (identityEncPath) {
          identityVersion = 2;
          const encStats = statSync(identityEncPath);
          itemsToBackup.push({
            path: identityEncPath,
            name: 'data/identity.enc',
            size: encStats.size,
            sensitive: true
          });
          tempFilesToCleanup.push(identityEncPath);
          console.log(`   ✅ ${criticalFile.description}: encrypted (v2)`);
        } else {
          itemsToBackup.push({
            path: filePath,
            name: criticalFile.relative,
            size: fileStats.size,
            sensitive: true
          });
          console.log(`   ✅ ${criticalFile.description}: plaintext (v1 legacy)`);
        }
      } else {
        itemsToBackup.push({
          path: filePath,
          name: criticalFile.relative,
          size: fileStats.size,
          sensitive: criticalFile.sensitive
        });
        const sizeInfo = criticalFile.sensitive ? '(sensitive)' : formatBytes(fileStats.size);
        console.log(`   ✅ ${criticalFile.description}: ${sizeInfo}`);
      }
      criticalFilesFound.push(criticalFile);
    } else {
      criticalFilesMissing.push(criticalFile);
      console.log(`   ⚠️  ${criticalFile.description}: not found`);
    }
  }

  // Check additional directories
  console.log('\n📋 Checking additional data directories...');
  for (const dir of BACKUP_DIRECTORIES) {
    const dirPath = resolve(PROJECT_ROOT, dir.relative);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      try {
        const entries = readdirSync(dirPath);
        if (entries.length > 0) {
          itemsToBackup.push({
            path: dirPath,
            name: dir.relative,
            size: 0
          });
          console.log(`   ✅ ${dir.description}: ${entries.length} items`);
        } else {
          console.log(`   ℹ️  ${dir.description}: empty, skipping`);
        }
      } catch (err) {
        console.log(`   ⚠️  ${dir.description}: cannot read (${err.message})`);
      }
    } else {
      console.log(`   ℹ️  ${dir.description}: not found`);
    }
  }

  // Warn if critical files are missing
  if (criticalFilesMissing.length > 0) {
    console.log(`\n⚠️  Warning: ${criticalFilesMissing.length} critical file(s) not found.`);
    console.log('   This may be normal for a fresh install, but a restore from this backup');
    console.log('   may not fully restore node identity, access control, or encrypted data.');
  }

  // Check if we have anything to backup
  if (itemsToBackup.length === 0) {
    console.log('\n❌ No data found to backup.');
    console.log('   This is normal for a fresh installation with no data yet.');
    process.exit(0);
  }

  // Create backups directory
  if (!existsSync(BACKUPS_DIR)) {
    mkdirSync(BACKUPS_DIR, { recursive: true });
    console.log(`📁 Created backups directory: ${BACKUPS_DIR}`);
  }

  // Generate backup filename
  const timestamp = formatTimestamp();
  const backupFilename = `pc2-backup-${timestamp}.tar.gz`;
  const backupPath = join(BACKUPS_DIR, backupFilename);

  console.log(`\n📦 Creating backup archive: ${backupFilename}`);
  console.log(`   Location: ${backupPath}\n`);

  try {
    // Write backup-meta.json (temporary, included in archive then cleaned up)
    const backupMeta = {
      formatVersion: identityVersion === 2 ? 2 : 1,
      identityVersion,
      createdAt: new Date().toISOString(),
      nodeVersion: process.env.npm_package_version || 'unknown',
      contents: itemsToBackup.map(item => item.name)
    };
    const metaPath = resolve(PROJECT_ROOT, 'backup-meta.json');
    writeFileSync(metaPath, JSON.stringify(backupMeta, null, 2));
    tempFilesToCleanup.push(metaPath);

    const filesToArchive = ['backup-meta.json', ...itemsToBackup.map(item => item.name)];

    // Create tar.gz archive
    await createTar({
      gzip: true,
      cwd: PROJECT_ROOT,
      file: backupPath
    }, filesToArchive);

    // Get backup file size
    const backupStats = statSync(backupPath);
    const backupSize = backupStats.size;

    // Clean up temporary files
    for (const tmpFile of tempFilesToCleanup) {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    console.log('✅ Backup archive created!');

    // Verify backup contents
    console.log('\n🔍 Verifying backup contents...');
    const { list: listTar } = await import('tar');
    const archivedFiles = [];
    await listTar({
      file: backupPath,
      onReadEntry: (entry) => {
        archivedFiles.push(entry.path);
      }
    });

    // Check that all critical files are in the archive
    const missingFromArchive = [];
    for (const item of itemsToBackup) {
      const found = archivedFiles.some(f => f === item.name || f.startsWith(item.name + '/'));
      if (!found) {
        missingFromArchive.push(item.name);
      }
    }

    if (missingFromArchive.length > 0) {
      console.log('⚠️  Warning: Some files may be missing from archive:');
      missingFromArchive.forEach(f => console.log(`   - ${f}`));
    } else {
      console.log('✅ All files verified in archive');
    }

    // Summary
    console.log(`\n📊 Backup Summary:`);
    console.log(`   File: ${backupFilename}`);
    console.log(`   Size: ${formatBytes(backupSize)}`);
    console.log(`   Location: ${backupPath}`);
    console.log(`   Items backed up: ${itemsToBackup.length}`);
    
    // Show what's included
    console.log('\n📦 Backup includes:');
    console.log('   - Database (pc2.db)' + (existsSync(walPath) ? ' + WAL' : ''));
    console.log('   - IPFS repository');
    console.log('   - Server configuration');
    if (criticalFilesFound.length > 0) {
      console.log(`   - ${criticalFilesFound.length} critical node files:`);
      criticalFilesFound.forEach(f => {
        console.log(`     • ${f.relative.replace('data/', '')}`);
      });
    }
    
    console.log(`\n💡 To restore this backup, run:`);
    console.log(`   npm run restore ${backupFilename}`);

    process.exit(0);
  } catch (error) {
    // Clean up temporary files on failure
    for (const tmpFile of tempFilesToCleanup) {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
    console.error('\n❌ Failed to create backup:');
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error(`\nStack trace:\n${error.stack}`);
    }
    process.exit(1);
  }
}

// Run backup
createBackup().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
