/**
 * PreviewStrategy - 預覽片段生成策略
 *
 * 優先級: 3
 * 功能: 為影片生成預覽片段 (3-6秒, 240p)
 *
 * 預覽片段規則：
 * - 影片 < 10秒：跳過
 * - 影片 10-30秒：3秒預覽
 * - 影片 >= 30秒：6秒預覽
 */

const MaintenanceStrategy = require('../base-strategy');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * 計算預覽時長
 */
function getPreviewDuration(videoDuration) {
  if (videoDuration < 10) return 0;
  if (videoDuration < 30) return 3;
  return 6;
}

class PreviewStrategy extends MaintenanceStrategy {
  constructor(options = {}) {
    super('preview', {
      priority: 3,
      batchSize: 5,
      interval: 500,
      ...options,
    });
  }

  async getPendingRecords(records, checker) {
    // 優先使用狀態欄位查詢，fallback 到 checker
    return records.filter((r) => {
      if (r.type !== 'video') return false;

      // 已完成或跳過的不處理
      if (r.previewStatus === 'completed' || r.previewStatus === 'skipped') {
        return false;
      }

      // 使用 checker 檢查是否真的需要預覽（有本地影片且沒預覽）
      return checker.needsPreview(r);
    });
  }

  async processRecord(record, context) {
    const { checker, dataDir, workr } = context;

    try {
      // 必須有原始 MP4/MOV
      if (!checker.hasLocalVideo(record)) {
        return { success: false, error: 'No local video' };
      }

      const videoPath = path.join(dataDir, record.backupPath);
      const previewFilename = `${record.id}.mp4`;
      const previewFullPath = path.join(dataDir, 'previews', previewFilename);
      const previewPath = `previews/${previewFilename}`;

      // 如果已存在，跳過
      if (fs.existsSync(previewFullPath)) {
        return {
          success: true,
          updates: {
            previewPath,
            previewReady: true,
            previewStatus: 'completed',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
        };
      }

      // 確保目錄存在
      const previewDir = path.dirname(previewFullPath);
      if (!fs.existsSync(previewDir)) {
        fs.mkdirSync(previewDir, { recursive: true });
      }

      // 取得影片時長
      const duration = record.duration || (await this.getVideoDuration(videoPath));
      const previewDuration = getPreviewDuration(duration);

      if (previewDuration === 0) {
        console.log(`[Preview] 跳過 ${record.id}：影片太短 (${duration?.toFixed(1)}s)`);
        return {
          success: true,
          updates: {
            isShortVideo: true,
            previewStatus: 'skipped',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
          reason: 'short_video',
        };
      }

      let success = false;

      // 策略 1: 使用 Workr
      if (workr) {
        try {
          const result = await workr.submitAndWait('preview', {
            videoPath,
            outputPath: previewFullPath,
            duration: previewDuration,
          });
          if (result.success && fs.existsSync(previewFullPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Preview] Workr 失敗: ${err.message}`);
        }
      }

      // 策略 2: 本地 FFmpeg
      if (!success) {
        try {
          await this.generatePreviewLocal(videoPath, previewFullPath, previewDuration);
          if (fs.existsSync(previewFullPath)) {
            success = true;
          }
        } catch (err) {
          console.log(`[Preview] 本地生成失敗: ${err.message}`);
        }
      }

      if (success) {
        const stats = fs.statSync(previewFullPath);
        console.log(`[Preview] ${record.id} 完成 (${Math.round(stats.size / 1024)}KB)`);

        return {
          success: true,
          updates: {
            previewPath,
            previewReady: true,
            previewStatus: 'completed',
            duration: duration || record.duration,
            lastProcessedAt: new Date().toISOString(),
          },
        };
      }

      return {
        success: false,
        error: 'Preview generation failed',
        updates: {
          previewStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        updates: {
          previewStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    }
  }

  /**
   * 取得影片時長
   */
  getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          videoPath,
        ],
        { windowsHide: true }
      );

      let stdout = '';
      ffprobe.stdout.on('data', (data) => (stdout += data));

      ffprobe.on('error', (err) => {
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('ffprobe failed'));
          return;
        }
        try {
          const info = JSON.parse(stdout);
          resolve(parseFloat(info.format?.duration || 0));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * 本地生成預覽片段
   */
  generatePreviewLocal(inputPath, outputPath, duration) {
    return new Promise((resolve, reject) => {
      const args = [
        '-i',
        inputPath,
        '-t',
        String(duration),
        '-vf',
        'scale=426:240',
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-preset',
        'fast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ];

      const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => (stderr += data.toString()));

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.slice(-300)));
          return;
        }
        resolve();
      });
    });
  }
}

module.exports = PreviewStrategy;
