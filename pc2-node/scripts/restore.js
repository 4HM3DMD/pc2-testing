#!/usr/bin/env node

/**
 * Restore Script
 * 
 * Restores PC2 Node data from a backup archive.
 * Handles all critical files for complete node restoration:
 * - Database + WAL files
 * - IPFS repository  
 * - Server configuration
 * - Encryption key (with secure 0600 permissions)
 * - Node configuration (owner wallet, access control, tethered DIDs)
 * - Boson identity:
 *     v2 backups: data/identity.enc (requires mnemonic for decryption at setup)
 *     v1 backups: data/identity.json (plaintext, legacy)
 * - Username registration
 * - Setup completion flag
 * - Installed apps (data/installed-apps/)
 * - AI agent memory (data/agents/)
 * 
 * Usage: node scripts/restore.js <backup-filename>
 * Example: node scripts/restore.js pc2-backup-20251219-120000.tar.gz
 */

import { existsSync, statSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync, copyFileSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { extract as extractTar } from 'tar';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get project root (pc2-node/test-fresh-install)
const PROJECT_ROOT = resolve(__dirname, '..');

// Paths relative to project root
const DB_PATH = process.env.DB_PATH || './data/pc2.db';
const IPFS_REPO_PATH = process.env.IPFS_REPO_PATH || './data/ipfs';
const CONFIG_PATH = './config/config.json';
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');

// Critical data files that need special handling during restore
const CRITICAL_DATA_FILES = [
  { relative: 'data/encryption.key', description: 'Encryption key', permissions: 0o600, sensitive: true },
  { relative: 'data/node-config.json', description: 'Node configuration' },
  { relative: 'data/identity.json', description: 'Boson identity', identity: true },
  { relative: 'data/username.json', description: 'Username registration' },
  { relative: 'data/setup-complete', description: 'Setup completion flag' }
];

// Directories to restore if present
const RESTORE_DIRECTORIES = [
  { relative: 'data/installed-apps', description: 'Installed applications' },
  { relative: 'data/agents', description: 'AI agent memory and history' }
];

// Resolve absolute paths
const dbPath = resolve(PROJECT_ROOT, DB_PATH);
const ipfsRepoPath = resolve(PROJECT_ROOT, IPFS_REPO_PATH);
const configPath = resolve(PROJECT_ROOT, CONFIG_PATH);
const dataDir = dirname(dbPath);
const configDir = dirname(configPath);

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
    const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/default.json'), 'utf8'));
    const port = process.env.PORT || config.server.port || 4200;
    execSync(`lsof -ti:${port}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop server if running
 */
function stopServer() {
  if (!isServerRunning()) {
    return;
  }

  console.log('⚠️  Server is running. Attempting to stop...');
  try {
    const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'config/default.json'), 'utf8'));
    const port = process.env.PORT || config.server.port || 4200;
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    console.log('✅ Server stopped');
  } catch (error) {
    console.log('⚠️  Could not stop server automatically.');
    console.log('   Please stop the server manually before restoring.');
    throw new Error('Server is running and could not be stopped');
  }
}

/**
 * Validate backup file
 */
function validateBackup(backupPath) {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const stats = statSync(backupPath);
  if (!stats.isFile()) {
    throw new Error(`Backup path is not a file: ${backupPath}`);
  }

  if (stats.size === 0) {
    throw new Error(`Backup file is empty: ${backupPath}`);
  }

  // Check if it's a tar.gz file
  if (!backupPath.endsWith('.tar.gz')) {
    throw new Error(`Backup file must be a .tar.gz archive: ${backupPath}`);
  }

  return stats;
}

/**
 * Restore from backup
 */
async function restoreBackup(backupFilename) {
  console.log('🔄 Restoring PC2 Node from backup...\n');

  // Resolve backup file path
  let backupPath;
  if (backupFilename.includes('/') || backupFilename.includes('\\')) {
    // Absolute or relative path provided
    backupPath = resolve(backupFilename);
  } else {
    // Filename only - look in backups directory
    backupPath = join(BACKUPS_DIR, backupFilename);
  }

  // Validate backup file
  console.log(`📦 Backup file: ${backupPath}`);
  const backupStats = validateBackup(backupPath);
  console.log(`   Size: ${formatBytes(backupStats.size)}`);
  console.log(`   Valid: ✅\n`);

  // Check if server is running
  if (isServerRunning()) {
    console.log('⚠️  Server is running. It must be stopped before restoring.');
    console.log('   Attempting to stop server...\n');
    try {
      stopServer();
      // Wait a moment for server to fully stop
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('❌ Cannot restore while server is running.');
      console.error('   Please stop the server manually and try again.');
      process.exit(1);
    }
  }

  // Create temporary extraction directory
  const tempDir = join(PROJECT_ROOT, '.restore-temp');
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  mkdirSync(tempDir, { recursive: true });

  console.log('📂 Extracting backup archive...');

  try {
    // Extract tar.gz archive
    await extractTar({
      file: backupPath,
      cwd: tempDir,
      strip: 0 // Keep directory structure
    });

    console.log('✅ Backup extracted successfully\n');

    // Read backup metadata if available
    const metaPath = join(tempDir, 'backup-meta.json');
    let backupMeta = { formatVersion: 1, identityVersion: 1 };
    if (existsSync(metaPath)) {
      try {
        backupMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
        console.log(`📋 Backup format version: ${backupMeta.formatVersion}`);
        console.log(`   Identity version: ${backupMeta.identityVersion === 2 ? 'v2 (mnemonic-derived, encrypted)' : 'v1 (legacy, plaintext)'}`);
        if (backupMeta.createdAt) {
          console.log(`   Created: ${backupMeta.createdAt}`);
        }
        console.log('');
      } catch {
        console.log('⚠️  Could not parse backup-meta.json, assuming v1 format\n');
      }
    } else {
      console.log('ℹ️  No backup-meta.json found, assuming v1 format\n');
    }

    const isV2Backup = backupMeta.formatVersion >= 2;

    // Validate extracted files
    const extractedData = join(tempDir, 'data');
    const extractedConfig = join(tempDir, 'config');

    const hasData = existsSync(extractedData);
    const hasConfig = existsSync(extractedConfig);

    if (!hasData && !hasConfig) {
      throw new Error('Backup archive does not contain expected data or config directories');
    }

    console.log('📋 Backup contents:');
    if (hasData) {
      console.log('   ✅ data/ directory found');
      if (existsSync(join(extractedData, 'pc2.db'))) {
        console.log('      ✅ Database file (pc2.db)');
      }
      if (existsSync(join(extractedData, 'pc2.db-wal'))) {
        console.log('      ✅ Database WAL file');
      }
      if (existsSync(join(extractedData, 'ipfs'))) {
        console.log('      ✅ IPFS repository');
      }

      // Check for identity (v2 = encrypted, v1 = plaintext)
      if (isV2Backup && existsSync(join(extractedData, 'identity.enc'))) {
        console.log('      ✅ Encrypted identity (identity.enc) - mnemonic required to unlock');
      } else if (existsSync(join(extractedData, 'identity.json'))) {
        console.log('      ✅ Boson identity (identity.json)');
      }

      // Check other critical files (skip identity.json as handled above)
      for (const criticalFile of CRITICAL_DATA_FILES) {
        if (criticalFile.identity) continue;
        const fileName = criticalFile.relative.replace('data/', '');
        if (existsSync(join(extractedData, fileName))) {
          console.log(`      ✅ ${criticalFile.description} (${fileName})`);
        }
      }

      // Check directories
      for (const dir of RESTORE_DIRECTORIES) {
        const dirName = dir.relative.replace('data/', '');
        const dirPath = join(extractedData, dirName);
        if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
          console.log(`      ✅ ${dir.description} (${dirName}/)`);
        }
      }
    }
    if (hasConfig && existsSync(join(extractedConfig, 'config.json'))) {
      console.log('   ✅ config/config.json found');
    }

    console.log('\n⚠️  WARNING: This will replace your current data!');
    console.log('   Current data will be backed up to .old-backup/');
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

    // Wait 5 seconds for user to cancel
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Backup current data (if exists)
    const oldBackupDir = join(PROJECT_ROOT, '.old-backup');
    if (existsSync(oldBackupDir)) {
      rmSync(oldBackupDir, { recursive: true, force: true });
    }
    mkdirSync(oldBackupDir, { recursive: true });

    console.log('💾 Backing up current data...');

    // Backup current database
    if (existsSync(dbPath)) {
      const oldDbDir = join(oldBackupDir, 'data');
      mkdirSync(oldDbDir, { recursive: true });
      renameSync(dbPath, join(oldDbDir, 'pc2.db'));
      console.log('   ✅ Current database backed up');
    }

    // Backup current IPFS repo
    if (existsSync(ipfsRepoPath)) {
      const oldIpfsPath = join(oldBackupDir, 'data', 'ipfs');
      mkdirSync(dirname(oldIpfsPath), { recursive: true });
      renameSync(ipfsRepoPath, oldIpfsPath);
      console.log('   ✅ Current IPFS repository backed up');
    }

    // Backup current config
    if (existsSync(configPath)) {
      const oldConfigDir = join(oldBackupDir, 'config');
      mkdirSync(oldConfigDir, { recursive: true });
      renameSync(configPath, join(oldConfigDir, 'config.json'));
      console.log('   ✅ Current configuration backed up');
    }

    // Backup current critical files
    for (const criticalFile of CRITICAL_DATA_FILES) {
      const filePath = resolve(PROJECT_ROOT, criticalFile.relative);
      if (existsSync(filePath)) {
        const oldFilePath = join(oldBackupDir, criticalFile.relative);
        mkdirSync(dirname(oldFilePath), { recursive: true });
        renameSync(filePath, oldFilePath);
        console.log(`   ✅ Current ${criticalFile.description} backed up`);
      }
    }

    // Backup current identity.enc if present
    const identityEncPath = resolve(PROJECT_ROOT, 'data/identity.enc');
    if (existsSync(identityEncPath)) {
      const oldIdentityEnc = join(oldBackupDir, 'data/identity.enc');
      mkdirSync(dirname(oldIdentityEnc), { recursive: true });
      renameSync(identityEncPath, oldIdentityEnc);
      console.log('   ✅ Current encrypted identity backed up');
    }

    // Backup current additional directories
    for (const dir of RESTORE_DIRECTORIES) {
      const dirPath = resolve(PROJECT_ROOT, dir.relative);
      if (existsSync(dirPath)) {
        const oldDirPath = join(oldBackupDir, dir.relative);
        mkdirSync(dirname(oldDirPath), { recursive: true });
        renameSync(dirPath, oldDirPath);
        console.log(`   ✅ Current ${dir.description} backed up`);
      }
    }

    // Backup SQLite WAL files if present
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) {
      const oldWalPath = join(oldBackupDir, 'data', 'pc2.db-wal');
      renameSync(walPath, oldWalPath);
      console.log('   ✅ Current database WAL backed up');
    }
    if (existsSync(shmPath)) {
      const oldShmPath = join(oldBackupDir, 'data', 'pc2.db-shm');
      renameSync(shmPath, oldShmPath);
      console.log('   ✅ Current database SHM backed up');
    }

    console.log('\n🔄 Restoring data from backup...');

    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Restore database
    if (existsSync(join(extractedData, 'pc2.db'))) {
      const sourceDb = join(extractedData, 'pc2.db');
      const destDb = dbPath;
      renameSync(sourceDb, destDb);
      console.log('   ✅ Database restored');
    }

    // Restore IPFS repo
    if (existsSync(join(extractedData, 'ipfs'))) {
      const sourceIpfs = join(extractedData, 'ipfs');
      if (!existsSync(dirname(ipfsRepoPath))) {
        mkdirSync(dirname(ipfsRepoPath), { recursive: true });
      }
      renameSync(sourceIpfs, ipfsRepoPath);
      console.log('   ✅ IPFS repository restored');
    }

    // Restore config
    if (existsSync(join(extractedConfig, 'config.json'))) {
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      const sourceConfig = join(extractedConfig, 'config.json');
      renameSync(sourceConfig, configPath);
      console.log('   ✅ Configuration restored');
    }

    // Restore SQLite WAL files if present in backup
    if (existsSync(join(extractedData, 'pc2.db-wal'))) {
      renameSync(join(extractedData, 'pc2.db-wal'), dbPath + '-wal');
      console.log('   ✅ Database WAL restored');
    }
    if (existsSync(join(extractedData, 'pc2.db-shm'))) {
      renameSync(join(extractedData, 'pc2.db-shm'), dbPath + '-shm');
      console.log('   ✅ Database SHM restored');
    }

    // Restore critical node files
    console.log('\n🔐 Restoring critical node files...');
    const restoredCritical = [];
    const missingCritical = [];

    for (const criticalFile of CRITICAL_DATA_FILES) {
      // Special handling for identity files
      if (criticalFile.identity) {
        const encSource = join(extractedData, 'identity.enc');
        const jsonSource = join(extractedData, 'identity.json');

        if (isV2Backup && existsSync(encSource)) {
          // v2 backup: copy encrypted identity; the setup wizard will decrypt it
          const destPath = resolve(PROJECT_ROOT, 'data/identity.enc');
          mkdirSync(dirname(destPath), { recursive: true });
          renameSync(encSource, destPath);
          chmodSync(destPath, 0o600);
          console.log('   ✅ Encrypted identity restored (identity.enc) — enter mnemonic at setup to unlock');
          restoredCritical.push({ ...criticalFile, description: 'Encrypted identity (v2)' });
        } else if (existsSync(jsonSource)) {
          // v1 backup: restore plaintext identity
          const destPath = resolve(PROJECT_ROOT, criticalFile.relative);
          mkdirSync(dirname(destPath), { recursive: true });
          renameSync(jsonSource, destPath);
          chmodSync(destPath, 0o600);
          console.log('   ✅ Boson identity restored (identity.json, legacy v1)');
          restoredCritical.push(criticalFile);
        } else {
          missingCritical.push(criticalFile);
        }
        continue;
      }

      const fileName = criticalFile.relative.replace('data/', '');
      const sourcePath = join(extractedData, fileName);
      const destPath = resolve(PROJECT_ROOT, criticalFile.relative);

      if (existsSync(sourcePath)) {
        mkdirSync(dirname(destPath), { recursive: true });
        renameSync(sourcePath, destPath);
        
        if (criticalFile.permissions) {
          chmodSync(destPath, criticalFile.permissions);
          console.log(`   ✅ ${criticalFile.description} restored (permissions: ${criticalFile.permissions.toString(8)})`);
        } else {
          console.log(`   ✅ ${criticalFile.description} restored`);
        }
        restoredCritical.push(criticalFile);
      } else {
        missingCritical.push(criticalFile);
      }
    }

    // Restore additional directories
    for (const dir of RESTORE_DIRECTORIES) {
      const dirName = dir.relative.replace('data/', '');
      const sourcePath = join(extractedData, dirName);
      const destPath = resolve(PROJECT_ROOT, dir.relative);

      if (existsSync(sourcePath) && statSync(sourcePath).isDirectory()) {
        mkdirSync(dirname(destPath), { recursive: true });
        renameSync(sourcePath, destPath);
        console.log(`   ✅ ${dir.description} restored`);
      }
    }

    if (missingCritical.length > 0) {
      console.log(`\n⚠️  Warning: ${missingCritical.length} critical file(s) not found in backup:`);
      missingCritical.forEach(f => console.log(`   - ${f.description} (${f.relative})`));
      console.log('   Some node features may not work correctly.');
    }

    // For v2 backups, remove setup-complete so the setup wizard runs
    // (user needs to enter mnemonic to decrypt identity)
    if (isV2Backup && existsSync(resolve(PROJECT_ROOT, 'data/identity.enc'))) {
      const setupCompletePath = resolve(PROJECT_ROOT, 'data/setup-complete');
      if (existsSync(setupCompletePath)) {
        rmSync(setupCompletePath);
        console.log('\n📋 Setup wizard will run on next start to complete identity restore.');
      }
    }

    // Clean up temporary directory
    rmSync(tempDir, { recursive: true, force: true });

    // Verification step
    console.log('\n🔍 Verifying restored files...');
    const verificationErrors = [];

    // Verify database
    if (existsSync(dbPath)) {
      const dbStats = statSync(dbPath);
      console.log(`   ✅ Database: ${formatBytes(dbStats.size)}`);
    } else {
      verificationErrors.push('Database not found after restore');
    }

    // Verify IPFS
    if (existsSync(ipfsRepoPath)) {
      console.log('   ✅ IPFS repository present');
    } else {
      console.log('   ⚠️  IPFS repository not found (may be OK for fresh backups)');
    }

    // Verify critical files
    for (const criticalFile of CRITICAL_DATA_FILES) {
      const filePath = resolve(PROJECT_ROOT, criticalFile.relative);
      if (existsSync(filePath)) {
        console.log(`   ✅ ${criticalFile.description}`);
      }
    }

    if (verificationErrors.length > 0) {
      console.log('\n⚠️  Verification warnings:');
      verificationErrors.forEach(err => console.log(`   - ${err}`));
    }

    console.log('\n✅ Restore completed successfully!');
    console.log(`\n📊 Restore Summary:`);
    console.log(`   Backup: ${basename(backupPath)}`);
    console.log(`   Previous data: ${oldBackupDir}`);
    console.log(`   Critical files restored: ${restoredCritical.length}/${CRITICAL_DATA_FILES.length}`);
    
    // Show what was restored
    console.log('\n📦 Restored:');
    if (existsSync(dbPath)) console.log('   - Database (pc2.db)');
    if (existsSync(ipfsRepoPath)) console.log('   - IPFS repository');
    if (existsSync(configPath)) console.log('   - Server configuration');
    restoredCritical.forEach(f => {
      console.log(`   - ${f.description}`);
    });

    console.log(`\n💡 You can now start the server:`);
    console.log(`   npm start`);
    
    if (isV2Backup && existsSync(resolve(PROJECT_ROOT, 'data/identity.enc'))) {
      console.log('\n📝 Next steps:');
      console.log('   1. Start the server: npm start');
      console.log('   2. The setup wizard will appear');
      console.log('   3. Choose "Restore from backup"');
      console.log('   4. Enter your 24-word mnemonic to unlock your identity');
      console.log('   5. Your domain (username.ela.city) will be restored');
    } else if (restoredCritical.length === CRITICAL_DATA_FILES.length) {
      console.log('\n🎉 Full node restoration complete!');
      console.log('   - Admin wallet will be recognized');
      console.log('   - All authorized accounts preserved');
      console.log('   - DID tethering intact');
      console.log('   - AI API keys will decrypt correctly');
    }

    process.exit(0);
  } catch (error) {
    // Clean up on error
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    console.error('\n❌ Failed to restore backup:');
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error(`\nStack trace:\n${error.stack}`);
    }
    process.exit(1);
  }
}

// Get backup filename from command line arguments
const backupFilename = process.argv[2];

if (!backupFilename) {
  console.error('❌ Error: Backup filename required');
  console.error('\nUsage:');
  console.error('   npm run restore <backup-filename>');
  console.error('\nExample:');
  console.error('   npm run restore pc2-backup-20251219-120000.tar.gz');
  console.error('\nAvailable backups:');
  if (existsSync(BACKUPS_DIR)) {
    const backups = readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.tar.gz'));
    if (backups.length === 0) {
      console.error('   (no backups found)');
    } else {
      backups.forEach(backup => {
        console.error(`   - ${backup}`);
      });
    }
  } else {
    console.error('   (backups directory does not exist)');
  }
  process.exit(1);
}

// Run restore
restoreBackup(backupFilename).catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
