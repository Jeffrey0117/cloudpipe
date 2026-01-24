/**
 * CleanupStrategy - 清理策略
 *
 * 優先級: 5 (最低)
 * 功能: 清理已有 HLS 版本的原始 MP4/MOV 檔案
 *
 * 安全檢查：
 * 1. HLS 必須存在且可播放
 * 2. 如果影片夠長，預覽片段必須存在
 * 3. 縮圖應該存在
 */

const MaintenanceStrategy = require('../base-strategy');
const path = require('path');
const fs = require('fs');

class CleanupStrategy extends MaintenanceStrategy {
  constructor(options = {}) {
    super('cleanup', {
      priority: 5,
      batchSize: 10,
      interval: 100,
      ...options,
    });
  }

  async getPendingRecords(records, checker) {
    // 優先使用狀態欄位查詢，fallback 到 checker
    return records.filter((r) => {
      // 使用狀態欄位
      if (r.hlsStatus === 'completed' && r.originalStatus === 'exists') {
        // 如果影片夠長需要預覽，確保預覽完成
        if (!r.isShortVideo && r.duration >= 10) {
          return r.previewStatus === 'completed';
        }
        return true;
      }
      // Fallback: 使用 checker（相容舊資料）
      if (!r.hlsStatus || !r.originalStatus) {
        return checker.canCleanupOriginal(r);
      }
      return false;
    });
  }

  async processRecord(record, context) {
    const { checker, dataDir, broadcastLog } = context;

    try {
      // 再次確認安全條件
      if (!checker.canCleanupOriginal(record)) {
        return { success: false, error: 'Not safe to cleanup' };
      }

      // 取得原始檔路徑
      const originalPath = path.join(dataDir, record.backupPath);

      if (!fs.existsSync(originalPath)) {
        return {
          success: true,
          updates: {
            backupPath: null,
            originalStatus: 'cleaned',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
          reason: 'already_deleted',
        };
      }

      // 取得檔案大小用於統計
      const stats = fs.statSync(originalPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      // 刪除檔案
      fs.unlinkSync(originalPath);
      console.log(`[Cleanup] 已刪除: ${record.backupPath} (${sizeMB}MB)`);

      if (broadcastLog) {
        broadcastLog({
          type: 'cleanup',
          recordId: record.id,
          file: record.backupPath,
          size: stats.size,
        });
      }

      return {
        success: true,
        updates: {
          backupPath: null,
          originalStatus: 'cleaned',
          lastProcessedAt: new Date().toISOString(),
        },
        freedBytes: stats.size,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        updates: {
          lastErrorAt: new Date().toISOString(),
        },
      };
    }
  }

  async afterProcess(results) {
    // 計算總共釋放的空間
    let totalFreed = 0;
    // results.errors 可能包含 freedBytes
    if (results.success > 0) {
      console.log(`[Cleanup] 清理完成，成功 ${results.success} 個檔案`);
    }
  }
}

module.exports = CleanupStrategy;
