/**
 * ThumbnailStrategy - 縮圖生成策略
 *
 * 優先級: 2
 * 功能: 為影片生成縮圖
 */

const MaintenanceStrategy = require('../base-strategy');
const path = require('path');
const fs = require('fs');

class ThumbnailStrategy extends MaintenanceStrategy {
  constructor(options = {}) {
    super('thumbnail', {
      priority: 2,
      batchSize: 20,
      interval: 500,
      ...options,
    });
  }

  async getPendingRecords(records, checker) {
    // 優先使用狀態欄位查詢，fallback 到 checker
    return records.filter((r) => {
      if (r.type !== 'video') return false;

      // 已完成或跳過的不處理
      if (r.thumbnailStatus === 'completed' || r.thumbnailStatus === 'skipped') {
        return false;
      }

      // 使用 checker 檢查是否真的需要縮圖（有可播放影片且沒縮圖）
      // 這樣無論 downloadStatus 是什麼值，只要有檔案就會處理
      return checker.needsThumbnail(r);
    });
  }

  async processRecord(record, context) {
    const { checker, dataDir, generateVideoThumbnail, workr } = context;

    try {
      // 取得影片來源
      const videoPath = checker.getVideoSourcePath(record);
      if (!videoPath) {
        return { success: false, error: 'No video source' };
      }

      // 目標縮圖路徑
      const thumbFilename = `${record.id}.webp`;
      const thumbPath = path.join(dataDir, 'thumbnails', thumbFilename);
      const thumbnailPath = `thumbnails/${thumbFilename}`;

      // 如果已存在，跳過
      if (fs.existsSync(thumbPath)) {
        return {
          success: true,
          updates: {
            thumbnailPath,
            thumbnailStatus: 'completed',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
        };
      }

      // 確保目錄存在
      const thumbDir = path.dirname(thumbPath);
      if (!fs.existsSync(thumbDir)) {
        fs.mkdirSync(thumbDir, { recursive: true });
      }

      let success = false;

      // 策略 1: 使用 Workr
      if (workr) {
        try {
          const result = await workr.submitAndWait('thumbnail', {
            videoPath,
            outputPath: thumbPath,
          });
          if (result.success && fs.existsSync(thumbPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Thumbnail] Workr 失敗: ${err.message}`);
        }
      }

      // 策略 2: 本地生成
      if (!success && generateVideoThumbnail) {
        try {
          const ok = await generateVideoThumbnail(videoPath, thumbPath);
          if (ok && fs.existsSync(thumbPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Thumbnail] 本地生成失敗: ${err.message}`);
        }
      }

      if (success) {
        return {
          success: true,
          updates: {
            thumbnailPath,
            thumbnailStatus: 'completed',
            lastProcessedAt: new Date().toISOString(),
          },
        };
      }

      return {
        success: false,
        error: 'Thumbnail generation failed',
        updates: {
          thumbnailStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        updates: {
          thumbnailStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    }
  }
}

module.exports = ThumbnailStrategy;
