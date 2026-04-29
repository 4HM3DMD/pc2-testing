/**
 * ContentSeedingService
 *
 * Orchestrates automatic content pinning and DHT announcement for purchased
 * marketplace content. Every buyer's node silently becomes a CDN edge —
 * pinning, announcing, and serving encrypted content via IPFS Bitswap.
 *
 * Capsule-ready interface: maps to a future `seeding-provider` capsule.
 */

import { statfsSync } from 'fs';
import { createLogger } from '../utils/logger.js';
import type { IPFSStorage } from '../storage/ipfs.js';
import type { DatabaseManager } from '../storage/database.js';
import type { Config } from '../config/loader.js';

const log = createLogger('seeding');

// ---------------------------------------------------------------------------
// CID normalization — handles ipfs://, /ipfs/, CIDv0/v1 prefixes
// ---------------------------------------------------------------------------

export function normalizeCID(raw: string): string {
  let cid = raw.trim();
  if (cid.startsWith('ipfs://')) cid = cid.slice(7);
  if (cid.startsWith('/ipfs/')) cid = cid.slice(6);
  // Strip any trailing path segments (e.g. "QmABC/metadata.json" → "QmABC")
  const slashIdx = cid.indexOf('/');
  if (slashIdx > 0) cid = cid.slice(0, slashIdx);
  return cid;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PinPriority = 'immediate' | 'background';
type PinItemStatus = 'queued' | 'pinning' | 'complete' | 'failed';

interface PinQueueItem {
  cid: string;
  walletAddress: string;
  priority: PinPriority;
  size: number;
  attempt: number;
  maxAttempts: number;
  addedAt: number;
  timeoutMs: number;
}

interface SeedingConfig {
  enabled: boolean;
  autoPinPurchases: boolean;
  diskQuotaPercent: number;
  minFreeBytes: number;
  maxConcurrentPins: number;
  maxUploadMbps: number;
  announceHotIntervalHours: number;
  announceWarmIntervalHours: number;
  announceColdIntervalHours: number;
}

// ---------------------------------------------------------------------------
// ContentSeedingService
// ---------------------------------------------------------------------------

export class ContentSeedingService {
  private ipfs: IPFSStorage | null = null;
  private db: DatabaseManager | null = null;
  private config: SeedingConfig;

  private queue: PinQueueItem[] = [];
  private activeCount = 0;
  private deferredOps: Array<() => void> = [];
  private isReady = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  private announcementTimers: ReturnType<typeof setInterval>[] = [];

  constructor(rawConfig: Config) {
    const s = rawConfig.seeding ?? {};
    this.config = {
      enabled: s.enabled ?? true,
      autoPinPurchases: s.auto_pin_purchases ?? true,
      // Percent-based quota is only a failsafe for truly-full disks.
      // Default 99% so a dev laptop at 96% usage (with 30+ GB genuinely
      // free on a 1TB drive) isn't locked out. Real gating is done by
      // minFreeBytes below.
      diskQuotaPercent: s.disk_quota_percent ?? 99,
      // Absolute floor on free disk before pinning pauses. 2 GB covers
      // a handful of concurrent video pins without risking fill-up.
      minFreeBytes: s.min_free_bytes ?? 2 * 1024 * 1024 * 1024,
      maxConcurrentPins: s.max_concurrent_pins ?? 3,
      maxUploadMbps: s.max_upload_mbps ?? 0,
      announceHotIntervalHours: s.announce_hot_interval_hours ?? 2,
      announceWarmIntervalHours: s.announce_warm_interval_hours ?? 6,
      announceColdIntervalHours: s.announce_cold_interval_hours ?? 12,
    };

    if (!this.config.enabled) {
      log.info('[Seeding] Disabled via config');
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Called once IPFS and DB are ready. Drains any deferred operations,
   * runs gap recovery, and starts tiered re-announcement schedules.
   */
  initialize(ipfs: IPFSStorage, db: DatabaseManager): void {
    this.ipfs = ipfs;
    this.db = db;
    this.isReady = true;

    if (!this.config.enabled) return;

    log.info(`[Seeding] Initialized — auto_pin=${this.config.autoPinPurchases}, min_free=${(this.config.minFreeBytes / (1024 ** 3)).toFixed(1)}GB, quota_cap=${this.config.diskQuotaPercent}%, max_concurrent=${this.config.maxConcurrentPins}`);

    // Drain any operations that arrived before IPFS was ready
    if (this.deferredOps.length > 0) {
      log.info(`[Seeding] Draining ${this.deferredOps.length} deferred operations`);
      for (const op of this.deferredOps) op();
      this.deferredOps = [];
    }

    // Gap recovery: re-queue incomplete pins
    this.runGapRecovery();

    // Ensure already-existing local file CIDs participate in ongoing announcements.
    const backfilled = this.db.backfillLocalCIDsToPinned();
    if (backfilled > 0) {
      log.info(`[Seeding] Backfilled ${backfilled} local CID(s) into pinned tracking`);
    }

    // Startup burst: re-announce all pinned CIDs immediately
    this.runStartupAnnouncement();

    // Schedule tiered re-announcements
    this.startAnnouncementSchedules();

    // Start queue drain loop (checks every 5s)
    this.drainTimer = setInterval(() => this.drainQueue(), 5000);
  }

  shutdown(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    for (const t of this.announcementTimers) clearInterval(t);
    this.announcementTimers = [];
    log.info('[Seeding] Shut down');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Queue a CID for seeding. Called after a marketplace purchase or
   * manual "Save to Cloud" action.
   */
  seedContent(
    rawCid: string,
    walletAddress: string,
    options?: { priority?: PinPriority; estimatedSizeBytes?: number }
  ): void {
    if (!this.config.enabled) return;

    const cid = normalizeCID(rawCid);
    const priority = options?.priority ?? 'immediate';
    const estimatedSize = options?.estimatedSizeBytes ?? 0;

    // Defer if IPFS not ready yet (Safeguard S4)
    if (!this.isReady) {
      log.debug(`[Seeding] IPFS not ready, deferring pin for ${cid}`);
      this.deferredOps.push(() => this.seedContent(rawCid, walletAddress, options));
      return;
    }

    // Dedup check (Safeguard S5)
    if (this.db?.isCIDPinnedOrQueued(cid)) {
      log.debug(`[Seeding] CID already pinned or queued, skipping: ${cid}`);
      return;
    }

    // Check if already in the in-memory queue
    if (this.queue.some(item => item.cid === cid)) {
      log.debug(`[Seeding] CID already in queue, skipping: ${cid}`);
      return;
    }

    // Adaptive timeout (Safeguard S7): base 180s + 2s per MB, capped at 10 min
    const estimatedMB = estimatedSize / (1024 * 1024);
    const timeoutMs = Math.min(180_000 + (estimatedMB * 2000), 600_000);

    const item: PinQueueItem = {
      cid,
      walletAddress,
      priority,
      size: estimatedSize,
      attempt: 0,
      maxAttempts: 3,
      addedAt: Date.now(),
      timeoutMs,
    };

    // Track as queued in DB
    this.db?.trackPinnedCID(cid, walletAddress, estimatedSize, 'marketplace');
    this.db?.updatePinStatus(cid, 'queued');

    // Insert by priority — immediate items go to front
    if (priority === 'immediate') {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }

    log.info(`[Seeding] Queued CID ${cid} (priority=${priority}, size=${estimatedSize > 0 ? `${estimatedMB.toFixed(1)}MB` : 'unknown'}, timeout=${Math.round(timeoutMs / 1000)}s)`);

    // Immediately try to drain
    this.drainQueue();
  }

  /**
   * Remove a CID from seeding. Stops serving, removes from DB.
   */
  unseedContent(rawCid: string): void {
    const cid = normalizeCID(rawCid);

    // Remove from in-memory queue if present
    this.queue = this.queue.filter(item => item.cid !== cid);

    // Remove from DB
    this.db?.removePinnedCID(cid);

    log.info(`[Seeding] Unseeded CID: ${cid}`);
  }

  getStats(): {
    enabled: boolean;
    queueLength: number;
    activeDownloads: number;
    config: SeedingConfig;
    disk: { quotaExceeded: boolean; pinnedSizeBytes: number };
  } {
    return {
      enabled: this.config.enabled,
      queueLength: this.queue.length,
      activeDownloads: this.activeCount,
      config: this.config,
      disk: {
        quotaExceeded: this.isQuotaExceeded(),
        pinnedSizeBytes: this.db?.getTotalPinnedSize() ?? 0,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Disk Quota Enforcement
  // -----------------------------------------------------------------------

  private isQuotaExceeded(): boolean {
    try {
      const stats = statfsSync('.');
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedBytes = totalBytes - freeBytes;
      const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

      const freeGB = freeBytes / (1024 ** 3);
      const minFreeGB = this.config.minFreeBytes / (1024 ** 3);

      // Primary gate: absolute free-bytes floor. Percent is a coarse
      // metric that punishes users on big-but-mostly-full laptop drives
      // even when they have dozens of GB genuinely free. Free bytes is
      // what actually matters for fitting the next pin.
      if (freeBytes < this.config.minFreeBytes) {
        const pinnedSize = this.db?.getTotalPinnedSize() ?? 0;
        log.warn(`[Seeding] Pinning paused — only ${freeGB.toFixed(1)}GB free (minimum: ${minFreeGB.toFixed(1)}GB, pinned: ${(pinnedSize / (1024 * 1024)).toFixed(0)}MB)`);
        return true;
      }

      // Secondary gate: hard % cap for extreme cases (e.g. 99%+ full).
      // Disabled when configured >=100.
      if (this.config.diskQuotaPercent > 0 && this.config.diskQuotaPercent < 100
          && usedPercent >= this.config.diskQuotaPercent) {
        const pinnedSize = this.db?.getTotalPinnedSize() ?? 0;
        log.warn(`[Seeding] Pinning paused — disk ${usedPercent.toFixed(1)}% used (cap: ${this.config.diskQuotaPercent}%, free: ${freeGB.toFixed(1)}GB, pinned: ${(pinnedSize / (1024 * 1024)).toFixed(0)}MB)`);
        return true;
      }
    } catch {
      // statfs not available (e.g., some containers) — allow pinning
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Queue Processing
  // -----------------------------------------------------------------------

  private async drainQueue(): Promise<void> {
    if (!this.isReady || !this.ipfs || !this.db) return;
    if (this.queue.length === 0) return;
    if (this.activeCount >= this.config.maxConcurrentPins) return;

    if (this.isQuotaExceeded()) {
      log.warn(`[Seeding] Queue paused — disk headroom too low, ${this.queue.length} item(s) waiting`);
      return;
    }

    const slotsAvailable = this.config.maxConcurrentPins - this.activeCount;
    const batch = this.queue.splice(0, slotsAvailable);

    for (const item of batch) {
      this.activeCount++;
      this.processPin(item).finally(() => {
        this.activeCount--;
        // Trigger next drain cycle
        if (this.queue.length > 0) this.drainQueue();
      });
    }
  }

  private async processPin(item: PinQueueItem): Promise<void> {
    const { cid, walletAddress } = item;
    item.attempt++;

    this.db?.updatePinStatus(cid, 'pinning');
    log.info(`[Seeding] Pinning CID ${cid} (attempt ${item.attempt}/${item.maxAttempts}, timeout ${Math.round(item.timeoutMs / 1000)}s)`);

    try {
      const result = await this.ipfs!.pinRemoteCID(cid, {
        timeoutMs: item.timeoutMs,
      });

      if (result.success) {
        this.db?.updatePinStatus(cid, 'complete');

        // Only let a pin-time size update the DB if it's at least as large
        // as what we already knew. Estimated sizes come from trusted NFT
        // metadata at queue time (e.g. 202881178 for a 193MB asset). The
        // pinRemoteCID fast path + partial CAR imports can report smaller
        // intermediate totals and must not clobber the honest estimate —
        // doing so makes pin-status/API and the .ddrm descriptor report a
        // "tiny file" for a fully-downloaded asset.
        if (result.size && result.size > 0) {
          const existingSize = this.db?.getPinnedCIDDetail(cid)?.size ?? 0;
          const authoritativeSize = Math.max(result.size, existingSize, item.size || 0);
          this.db?.trackPinnedCID(cid, walletAddress, authoritativeSize, 'marketplace');
        }

        log.info(`[Seeding] Pinned CID ${cid} (${result.size ? `${(result.size / (1024 * 1024)).toFixed(1)}MB` : 'size unknown'}, ${result.timeMs ?? 0}ms)`);

        // Announce to DHT so peers can discover this content
        if (this.ipfs!.canAnnounce()) {
          this.ipfs!.announceCID(cid).then(announced => {
            if (announced) {
              log.debug(`[Seeding] Announced CID to DHT: ${cid}`);
              this.db?.updatePinnedCIDAnnouncedAt(cid);
            }
          }).catch(err => {
            log.warn(`[Seeding] DHT announce failed for ${cid}: ${err instanceof Error ? err.message : 'unknown'}`);
          });
        }
      } else {
        throw new Error('Pin returned success=false');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isContentNotFound = msg.includes('not found') || msg.includes('no providers');
      const isNetworkError = msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('timeout');

      if (isContentNotFound) {
        // Content doesn't exist on IPFS — give up (Safeguard S12)
        this.db?.updatePinStatus(cid, 'failed');
        log.warn(`[Seeding] Pin failed (content not found, giving up): ${cid} — ${msg}`);
        return;
      }

      if (item.attempt < item.maxAttempts) {
        // Retry with exponential backoff (30s, 60s, 120s)
        const delayMs = 30_000 * Math.pow(2, item.attempt - 1);
        log.warn(`[Seeding] Pin failed (attempt ${item.attempt}/${item.maxAttempts}, retrying in ${delayMs / 1000}s): ${cid} — ${msg}`);

        setTimeout(() => {
          this.queue.push(item);
          this.drainQueue();
        }, delayMs);
      } else {
        this.db?.updatePinStatus(cid, 'failed');
        log.error(`[Seeding] Pin failed after ${item.maxAttempts} attempts, giving up: ${cid} — ${msg}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Gap Recovery
  // -----------------------------------------------------------------------

  private runGapRecovery(): void {
    if (!this.db) return;

    const incomplete = this.db.getIncompletePins();
    if (incomplete.length === 0) {
      log.info('[Seeding] Gap recovery: no incomplete pins');
      return;
    }

    const breakdown = incomplete.reduce<Record<string, number>>((acc, i) => {
      // DB rows of 'queued'/'pinning'/'failed' status — group so operators
      // can see at-a-glance what the restart cleaned up (vs. what needs a
      // manual nudge).
      const row = this.db!.getPinnedCIDDetail(i.cid);
      const status = row?.pin_status ?? 'unknown';
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {});

    log.info(`[Seeding] Gap recovery: found ${incomplete.length} incomplete pin(s) (${JSON.stringify(breakdown)}), re-queuing at background priority`);
    for (const item of incomplete) {
      this.seedContent(item.cid, item.wallet_address, {
        priority: 'background',
        estimatedSizeBytes: item.size,
      });
    }
  }

  // -----------------------------------------------------------------------
  // DHT Announcement Schedules
  // -----------------------------------------------------------------------

  private async runStartupAnnouncement(): Promise<void> {
    if (!this.ipfs?.canAnnounce() || !this.db) return;

    const allCIDs = this.db.getAllAnnouncableCIDs();
    if (allCIDs.length === 0) return;

    log.info(`[Seeding] Startup burst: re-announcing ${allCIDs.length} CIDs to DHT`);
    const result = await this.ipfs.announceMultipleCIDs(allCIDs);
    log.info(`[Seeding] Startup announcement: ${result.success} success, ${result.failed} failed`);
  }

  private startAnnouncementSchedules(): void {
    if (!this.ipfs?.canAnnounce() || !this.db) return;

    const hotMs = this.config.announceHotIntervalHours * 60 * 60 * 1000;
    const warmMs = this.config.announceWarmIntervalHours * 60 * 60 * 1000;
    const coldMs = this.config.announceColdIntervalHours * 60 * 60 * 1000;

    // Hot: recently served content, re-announce frequently
    this.announcementTimers.push(setInterval(async () => {
      if (!this.db || !this.ipfs?.canAnnounce()) return;
      const hotCIDs = this.db.getHotCIDs();
      if (hotCIDs.length === 0) return;
      log.debug(`[Seeding] Re-announcing ${hotCIDs.length} hot CID(s)`);
      await this.ipfs.announceMultipleCIDs(hotCIDs);
    }, hotMs));

    // Warm: served in last week
    this.announcementTimers.push(setInterval(async () => {
      if (!this.db || !this.ipfs?.canAnnounce()) return;
      const warmCIDs = this.db.getWarmCIDs();
      if (warmCIDs.length === 0) return;
      log.debug(`[Seeding] Re-announcing ${warmCIDs.length} warm CID(s)`);
      await this.ipfs.announceMultipleCIDs(warmCIDs);
    }, warmMs));

    // Cold: everything else
    this.announcementTimers.push(setInterval(async () => {
      if (!this.db || !this.ipfs?.canAnnounce()) return;
      const coldCIDs = this.db.getColdCIDs();
      if (coldCIDs.length === 0) return;
      log.debug(`[Seeding] Re-announcing ${coldCIDs.length} cold CID(s)`);
      await this.ipfs.announceMultipleCIDs(coldCIDs);
    }, coldMs));

    log.info(`[Seeding] Tiered re-announcement: hot=${this.config.announceHotIntervalHours}h, warm=${this.config.announceWarmIntervalHours}h, cold=${this.config.announceColdIntervalHours}h`);
  }
}
