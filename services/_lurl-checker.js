/**
 * RecordChecker - 共用記錄檢查邏輯
 *
 * 統一所有檔案存在性檢查，消除重複代碼
 */

const fs = require('fs');
const path = require('path');

class RecordChecker {
  constructor(dataDir, hlsDir, previewsDir) {
    this.dataDir = dataDir;
    this.hlsDir = hlsDir;
    this.previewsDir = previewsDir;
  }

  /**
   * 是否為短影片（<10秒）
   */
  isShortVideo(record) {
    return record.isShortVideo || (record.duration && record.duration < 10);
  }

  /**
   * 影片是否有本地 MP4/MOV
   */
  hasLocalVideo(record) {
    if (!record.backupPath) return false;
    const ext = path.extname(record.backupPath).toLowerCase();
    if (!['.mp4', '.mov'].includes(ext)) return false;
    return fs.existsSync(path.join(this.dataDir, record.backupPath));
  }

  /**
   * 是否有 HLS 版本
   */
  hasHLS(record) {
    if (!record.hlsReady) return false;
    return fs.existsSync(path.join(this.hlsDir, record.id, 'master.m3u8'));
  }

  /**
   * 是否有預覽片段
   */
  hasPreview(record) {
    if (!record.previewPath) return false;
    return fs.existsSync(path.join(this.dataDir, record.previewPath));
  }

  /**
   * 是否有任何可播放版本（本地檔或 HLS）
   */
  hasPlayableVideo(record) {
    return this.hasLocalVideo(record) || this.hasHLS(record);
  }

  /**
   * 是否有縮圖
   */
  hasThumbnail(record) {
    if (!record.thumbnailPath) return false;
    return fs.existsSync(path.join(this.dataDir, record.thumbnailPath));
  }

  /**
   * 是否有本地圖片檔
   */
  hasLocalImage(record) {
    if (!record.backupPath) return false;
    return fs.existsSync(path.join(this.dataDir, record.backupPath));
  }

  /**
   * 是否有任何本地檔案（視訊或圖片）
   */
  hasLocalFile(record) {
    if (record.type === 'video') {
      return this.hasLocalVideo(record) || this.hasHLS(record);
    }
    return this.hasLocalImage(record);
  }

  /**
   * 是否需要下載
   */
  needsDownload(record) {
    if (!record.fileUrl) return false;
    if (record.type === 'video') {
      return !this.hasPlayableVideo(record);
    }
    return !this.hasLocalImage(record);
  }

  /**
   * 是否需要縮圖（影片必須有可播放版本）
   */
  needsThumbnail(record) {
    if (record.type !== 'video') return false;
    if (this.hasThumbnail(record)) return false;
    return this.hasPlayableVideo(record);
  }

  /**
   * 是否需要預覽片段
   */
  needsPreview(record) {
    if (record.type !== 'video') return false;
    if (record.isShortVideo) return false;
    if (this.hasPreview(record)) return false;
    // 需要有原始 MP4/MOV 才能生成預覽
    return this.hasLocalVideo(record);
  }

  /**
   * 是否需要 HLS 轉檔
   */
  needsHLS(record) {
    if (record.type !== 'video') return false;
    if (record.hlsReady) return false;
    if (record.isShortVideo) return false;
    return this.hasLocalVideo(record);
  }

  /**
   * 是否可清理原始檔（HLS + 預覽都就緒）
   */
  canCleanupOriginal(record) {
    if (record.type !== 'video') return false;
    if (!record.hlsReady) return false;
    if (!this.hasHLS(record)) return false;
    // 如果影片夠長需要預覽，必須確保預覽存在
    if (!record.isShortVideo && record.duration >= 10) {
      if (!this.hasPreview(record)) return false;
    }
    return this.hasLocalVideo(record);
  }

  /**
   * 取得影片來源路徑（優先本地，其次 HLS）
   */
  getVideoSourcePath(record) {
    if (this.hasLocalVideo(record)) {
      return path.join(this.dataDir, record.backupPath);
    }
    if (this.hasHLS(record)) {
      return path.join(this.hlsDir, record.id, 'master.m3u8');
    }
    return null;
  }

  /**
   * 批量檢查記錄（使用 fs.existsSync）
   */
  analyzeRecords(records) {
    const stats = {
      total: records.length,
      videos: 0,
      images: 0,
      needsDownload: [],
      needsThumbnail: [],
      needsPreview: [],
      needsHLS: [],
      canCleanup: [],
      missingFiles: [],
    };

    for (const record of records) {
      if (record.type === 'video') {
        stats.videos++;
      } else {
        stats.images++;
      }

      if (this.needsDownload(record)) {
        stats.needsDownload.push(record);
      }

      if (this.needsThumbnail(record)) {
        stats.needsThumbnail.push(record);
      }

      if (this.needsPreview(record)) {
        stats.needsPreview.push(record);
      }

      if (this.needsHLS(record)) {
        stats.needsHLS.push(record);
      }

      if (this.canCleanupOriginal(record)) {
        stats.canCleanup.push(record);
      }

      if (!this.hasLocalFile(record)) {
        stats.missingFiles.push(record);
      }
    }

    return stats;
  }

  /**
   * 使用狀態欄位分析記錄（快速，不檢查磁碟）
   */
  analyzeRecordsByStatus(records) {
    const stats = {
      total: records.length,
      videos: 0,
      images: 0,
      byDownloadStatus: {},
      byThumbnailStatus: {},
      byPreviewStatus: {},
      byHlsStatus: {},
      byOriginalStatus: {},
      bySourceStatus: {},
      // 待處理統計
      pending: {
        download: 0,
        thumbnail: 0,
        preview: 0,
        hls: 0,
        cleanup: 0,
      },
    };

    for (const record of records) {
      if (record.type === 'video') {
        stats.videos++;
      } else {
        stats.images++;
      }

      // 統計各狀態
      const ds = record.downloadStatus || 'unknown';
      const ts = record.thumbnailStatus || 'unknown';
      const ps = record.previewStatus || 'unknown';
      const hs = record.hlsStatus || 'unknown';
      const os = record.originalStatus || 'unknown';
      const ss = record.sourceStatus || 'unknown';

      stats.byDownloadStatus[ds] = (stats.byDownloadStatus[ds] || 0) + 1;
      stats.byThumbnailStatus[ts] = (stats.byThumbnailStatus[ts] || 0) + 1;
      stats.byPreviewStatus[ps] = (stats.byPreviewStatus[ps] || 0) + 1;
      stats.byHlsStatus[hs] = (stats.byHlsStatus[hs] || 0) + 1;
      stats.byOriginalStatus[os] = (stats.byOriginalStatus[os] || 0) + 1;
      stats.bySourceStatus[ss] = (stats.bySourceStatus[ss] || 0) + 1;

      // 待處理統計
      if (ds === 'pending' || ds === 'failed') {
        stats.pending.download++;
      }
      if (ts === 'pending' || ts === 'failed') {
        stats.pending.thumbnail++;
      }
      if (ps === 'pending' || ps === 'failed') {
        stats.pending.preview++;
      }
      if (hs === 'pending' || hs === 'failed') {
        stats.pending.hls++;
      }
      if (hs === 'completed' && os === 'exists') {
        stats.pending.cleanup++;
      }
    }

    return stats;
  }

  /**
   * 同步單筆記錄的狀態（檢查磁碟並更新狀態欄位）
   * @returns {object} 需要更新的欄位
   */
  syncRecordStatus(record) {
    const updates = {};

    // === 檢查下載/原始檔狀態 ===
    if (record.type === 'video') {
      const hasLocal = this.hasLocalVideo(record);
      const hasHls = this.hasHLS(record);

      if (hasLocal) {
        if (record.originalStatus !== 'exists') {
          updates.originalStatus = 'exists';
        }
        if (record.downloadStatus !== 'completed') {
          updates.downloadStatus = 'completed';
        }
      } else if (hasHls) {
        if (record.originalStatus !== 'cleaned') {
          updates.originalStatus = 'cleaned';
        }
        if (record.downloadStatus !== 'completed') {
          updates.downloadStatus = 'completed';
        }
      } else {
        if (record.originalStatus !== 'missing') {
          updates.originalStatus = 'missing';
        }
        // 只有有 fileUrl 時才設為 pending
        if (record.fileUrl && record.downloadStatus === 'completed') {
          updates.downloadStatus = 'pending';
        }
      }
    } else {
      // 圖片
      const hasLocal = this.hasLocalImage(record);
      if (hasLocal) {
        if (record.originalStatus !== 'exists') {
          updates.originalStatus = 'exists';
        }
        if (record.downloadStatus !== 'completed') {
          updates.downloadStatus = 'completed';
        }
      } else {
        if (record.originalStatus !== 'missing') {
          updates.originalStatus = 'missing';
        }
        if (record.fileUrl && record.downloadStatus === 'completed') {
          updates.downloadStatus = 'pending';
        }
      }
    }

    // === 檢查縮圖狀態 ===
    if (record.type === 'video') {
      const hasThumbnail = this.hasThumbnail(record);
      if (hasThumbnail) {
        if (record.thumbnailStatus !== 'completed') {
          updates.thumbnailStatus = 'completed';
        }
      } else if (record.thumbnailStatus === 'completed') {
        updates.thumbnailStatus = 'pending';
      }
    }

    // === 檢查預覽狀態 ===
    if (record.type === 'video') {
      const hasPreview = this.hasPreview(record);
      if (hasPreview) {
        if (record.previewStatus !== 'completed') {
          updates.previewStatus = 'completed';
        }
      } else if (record.previewStatus === 'completed') {
        // 如果是短影片，應該是 skipped
        if (this.isShortVideo(record)) {
          updates.previewStatus = 'skipped';
        } else {
          updates.previewStatus = 'pending';
        }
      }
    }

    // === 檢查 HLS 狀態 ===
    if (record.type === 'video') {
      const hasHls = this.hasHLS(record);
      if (hasHls) {
        if (record.hlsStatus !== 'completed') {
          updates.hlsStatus = 'completed';
        }
      } else if (record.hlsStatus === 'completed') {
        // 如果是短影片，應該是 skipped
        if (this.isShortVideo(record)) {
          updates.hlsStatus = 'skipped';
        } else {
          updates.hlsStatus = 'pending';
        }
      }
    }

    return updates;
  }

  /**
   * 批量同步狀態（驗證並修正狀態欄位）
   * @param {Array} records - 所有記錄
   * @param {Function} updateRecord - 更新記錄的函數
   * @param {object} options - 選項
   * @returns {object} 同步統計
   */
  syncAllStatuses(records, updateRecord, options = {}) {
    const { dryRun = false } = options;
    const stats = {
      total: records.length,
      synced: 0,
      unchanged: 0,
      errors: [],
    };

    console.log(`[RecordChecker] 開始同步狀態 (${records.length} 筆, dryRun=${dryRun})`);

    for (const record of records) {
      try {
        const updates = this.syncRecordStatus(record);

        if (Object.keys(updates).length > 0) {
          if (!dryRun) {
            updateRecord(record.id, updates);
          }
          stats.synced++;
        } else {
          stats.unchanged++;
        }
      } catch (err) {
        stats.errors.push({ id: record.id, error: err.message });
      }
    }

    console.log(`[RecordChecker] 同步完成: 更新 ${stats.synced}, 無變化 ${stats.unchanged}, 錯誤 ${stats.errors.length}`);
    return stats;
  }
}

module.exports = RecordChecker;
