/**
 * DownloadStrategy - 下載重試策略
 *
 * 優先級: 1 (最高)
 * 功能: 下載缺失的影片/圖片檔案
 */

const MaintenanceStrategy = require('../base-strategy');
const path = require('path');
const fs = require('fs');

class DownloadStrategy extends MaintenanceStrategy {
  constructor(options = {}) {
    super('download', {
      priority: 1,
      batchSize: 5,
      interval: 1000,
      retryCount: 3,
      ...options,
    });
  }

  async getPendingRecords(records, checker) {
    // 優先使用狀態欄位查詢，fallback 到 checker
    return records.filter((r) => {
      // 使用狀態欄位
      if (r.downloadStatus === 'pending' || r.downloadStatus === 'failed') {
        return !!r.fileUrl; // 必須有 fileUrl 才能下載
      }
      // Fallback: 使用 checker（相容舊資料）
      if (!r.downloadStatus || r.downloadStatus === 'unknown') {
        return checker.needsDownload(r);
      }
      return false;
    });
  }

  async processRecord(record, context) {
    const { downloadFile, dataDir, workr, lurlRetry } = context;

    if (!record.fileUrl) {
      return { success: false, error: 'No file URL' };
    }

    try {
      // 決定目標路徑
      const folder = record.type === 'video' ? 'videos' : 'images';

      // 安全解析 URL 副檔名
      let urlExt = '';
      try {
        urlExt = path.extname(new URL(record.fileUrl).pathname).toLowerCase();
      } catch {
        urlExt = record.type === 'video' ? '.mp4' : '.jpg';
      }

      const ext =
        record.type === 'video'
          ? ['.mp4', '.mov', '.webm', '.avi'].includes(urlExt)
            ? urlExt
            : '.mp4'
          : ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(urlExt)
            ? urlExt
            : '.jpg';

      const filename = `${record.id}${ext}`;
      const destPath = path.join(dataDir, folder, filename);
      const backupPath = `${folder}/${filename}`;

      // 如果已存在，跳過
      if (fs.existsSync(destPath)) {
        return {
          success: true,
          updates: {
            backupPath,
            downloadStatus: 'completed',
            originalStatus: 'exists',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
        };
      }

      // 嘗試下載
      let success = false;

      // 策略 1: 使用標準下載
      if (downloadFile) {
        try {
          await downloadFile(record.fileUrl, destPath, record.pageUrl || '');
          if (fs.existsSync(destPath)) {
            const stats = fs.statSync(destPath);
            if (stats.size > 1024) {
              // 至少 1KB
              success = true;
            }
          }
        } catch (err) {
          console.log(`[Download] 標準下載失敗: ${err.message}`);
        }
      }

      // 策略 2: 使用 Workr
      if (!success && workr) {
        try {
          const result = await workr.submitAndWait('download', {
            url: record.fileUrl,
            destPath,
            referer: record.pageUrl,
          });
          if (result.success && fs.existsSync(destPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Download] Workr 下載失敗: ${err.message}`);
        }
      }

      // 策略 3: 使用 Puppeteer 備援
      if (!success && lurlRetry) {
        try {
          const result = await lurlRetry.downloadWithPuppeteer(
            record.fileUrl,
            destPath,
            record.pageUrl
          );
          if (result.success && fs.existsSync(destPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Download] Puppeteer 下載失敗: ${err.message}`);
        }
      }

      if (success) {
        return {
          success: true,
          updates: {
            backupPath,
            downloadStatus: 'completed',
            downloadError: null,
            originalStatus: 'exists',
            lastProcessedAt: new Date().toISOString(),
          },
        };
      }

      // 下載失敗，增加重試計數
      const retries = (record.downloadRetries || 0) + 1;
      return {
        success: false,
        error: 'All download strategies failed',
        updates: {
          downloadStatus: 'failed',
          downloadRetries: retries,
          downloadError: 'All download strategies failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      const retries = (record.downloadRetries || 0) + 1;
      return {
        success: false,
        error: err.message,
        updates: {
          downloadStatus: 'failed',
          downloadRetries: retries,
          downloadError: err.message,
          lastErrorAt: new Date().toISOString(),
        },
      };
    }
  }
}

module.exports = DownloadStrategy;
