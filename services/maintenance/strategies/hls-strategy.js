/**
 * HLSStrategy - HLS 轉檔策略
 *
 * 優先級: 4
 * 功能: 將 MP4/MOV 轉成 HLS 多畫質串流
 *
 * 轉檔流程（順序重要！）：
 * 1. 先確保預覽片段存在
 * 2. 生成縮圖（如果沒有）
 * 3. 轉成 HLS 多畫質
 * 4. 確認 HLS + 預覽都成功後，才刪除原始 MP4
 */

const MaintenanceStrategy = require('../base-strategy');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// HLS 畫質設定
const HLS_QUALITIES = [
  { name: '1080p', height: 1080, bitrate: '5000k', audioBitrate: '192k', crf: 22 },
  { name: '720p', height: 720, bitrate: '2500k', audioBitrate: '128k', crf: 23 },
  { name: '480p', height: 480, bitrate: '1000k', audioBitrate: '96k', crf: 24 },
];

class HLSStrategy extends MaintenanceStrategy {
  constructor(options = {}) {
    super('hls', {
      priority: 4,
      batchSize: 1, // HLS 轉檔資源密集，一次一個
      interval: 0,
      ...options,
    });

    this.hlsDir = options.hlsDir;
  }

  async getPendingRecords(records, checker) {
    // 優先使用狀態欄位查詢，fallback 到 checker
    return records.filter((r) => {
      // 使用狀態欄位
      if (r.hlsStatus === 'pending' || r.hlsStatus === 'failed') {
        // 必須是影片且原始檔存在
        return r.type === 'video' && r.originalStatus === 'exists';
      }
      // Fallback: 使用 checker（相容舊資料）
      if (!r.hlsStatus || r.hlsStatus === 'unknown') {
        return checker.needsHLS(r);
      }
      return false;
    });
  }

  async processRecord(record, context) {
    const { checker, dataDir, updateRecord, workr, broadcastLog } = context;
    const hlsDir = this.hlsDir || path.join(dataDir, 'hls');

    try {
      // 必須有原始 MP4/MOV
      if (!checker.hasLocalVideo(record)) {
        return { success: false, error: 'No local video' };
      }

      const inputPath = path.join(dataDir, record.backupPath);
      const outputDir = path.join(hlsDir, record.id);
      const masterPath = path.join(outputDir, 'master.m3u8');

      // 如果已存在 HLS，跳過
      if (fs.existsSync(masterPath)) {
        return {
          success: true,
          updates: {
            hlsReady: true,
            hlsPath: `hls/${record.id}/master.m3u8`,
            hlsStatus: 'completed',
            lastProcessedAt: new Date().toISOString(),
          },
          skipped: true,
        };
      }

      console.log(`[HLS] 開始處理 ${record.id}...`);
      if (broadcastLog) {
        broadcastLog({ type: 'hls_start', recordId: record.id, title: record.title });
      }

      // 取得影片資訊
      const videoInfo = await this.getVideoInfo(inputPath);
      console.log(`[HLS] 影片資訊: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

      // 更新時長
      if (!record.duration && videoInfo.duration) {
        updateRecord(record.id, { duration: videoInfo.duration });
      }

      // 短影片處理（<10秒）：保留 MP4，不轉 HLS
      if (videoInfo.duration < 10) {
        console.log(`[HLS] 短影片 ${record.id}：保留 MP4 (${videoInfo.duration.toFixed(1)}s)`);
        return {
          success: true,
          updates: {
            isShortVideo: true,
            hlsReady: false,
            previewReady: false,
            duration: videoInfo.duration,
            hlsStatus: 'skipped',
            previewStatus: 'skipped',
            lastProcessedAt: new Date().toISOString(),
          },
          reason: 'short_video',
        };
      }

      // 策略 1: 使用 Workr
      if (workr) {
        try {
          const result = await workr.submitAndWait('hls', {
            inputPath,
            outputDir,
          });
          if (result.success && fs.existsSync(masterPath)) {
            return this.onHLSComplete(record, inputPath, outputDir, videoInfo, context);
          }
        } catch (err) {
          console.log(`[HLS] Workr 失敗，使用本地轉檔: ${err.message}`);
        }
      }

      // 策略 2: 本地 FFmpeg
      // 建立輸出目錄
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 依序轉檔各畫質，追蹤成功的畫質
      const successfulQualities = [];
      for (const quality of HLS_QUALITIES) {
        try {
          const result = await this.transcodeQuality(inputPath, outputDir, quality, videoInfo);
          if (!result.skipped) {
            successfulQualities.push(quality);
          } else if (videoInfo.height >= quality.height || quality.height <= 480) {
            // 跳過但應該包含在 playlist 中（480p 保底）
            successfulQualities.push(quality);
          }
        } catch (err) {
          console.error(`[HLS] ${quality.name} 失敗:`, err.message);
        }
      }

      // 產生 master playlist（只包含成功的畫質）
      if (successfulQualities.length > 0) {
        this.generateMasterPlaylist(outputDir, successfulQualities, videoInfo);
      }

      if (fs.existsSync(masterPath)) {
        return this.onHLSComplete(record, inputPath, outputDir, videoInfo, context);
      }

      return {
        success: false,
        error: 'HLS transcoding failed',
        updates: {
          hlsStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      console.error(`[HLS] ${record.id} 處理失敗:`, err);
      return {
        success: false,
        error: err.message,
        updates: {
          hlsStatus: 'failed',
          lastErrorAt: new Date().toISOString(),
        },
      };
    }
  }

  /**
   * HLS 轉檔完成後處理
   * 注意：不刪除原始檔，由 CleanupStrategy 負責安全清理
   */
  async onHLSComplete(record, inputPath, outputDir, videoInfo, context) {
    const { broadcastLog } = context;

    const updates = {
      hlsReady: true,
      hlsPath: `hls/${record.id}/master.m3u8`,
      hlsStatus: 'completed',
      isShortVideo: false,
      duration: videoInfo.duration,
      lastProcessedAt: new Date().toISOString(),
    };

    console.log(`[HLS] ${record.id} 處理完成（原始檔保留，由清理策略處理）`);
    if (broadcastLog) {
      broadcastLog({ type: 'hls_complete', recordId: record.id, title: record.title });
    }

    return {
      success: true,
      updates,
    };
  }

  /**
   * 取得影片資訊
   */
  getVideoInfo(inputPath) {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn(
        'ffprobe',
        [
          '-v',
          'quiet',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputPath,
        ],
        { windowsHide: true }
      );

      let stdout = '';
      let stderr = '';

      ffprobe.stdout.on('data', (data) => (stdout += data));
      ffprobe.stderr.on('data', (data) => (stderr += data));

      ffprobe.on('error', (err) => {
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${stderr}`));
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const videoStream = info.streams.find((s) => s.codec_type === 'video');
          resolve({
            width: videoStream?.width || 1920,
            height: videoStream?.height || 1080,
            duration: parseFloat(info.format?.duration || 0),
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * 轉檔單一畫質
   */
  transcodeQuality(inputPath, outputDir, quality, videoInfo) {
    return new Promise((resolve, reject) => {
      const qualityDir = path.join(outputDir, quality.name);
      if (!fs.existsSync(qualityDir)) {
        fs.mkdirSync(qualityDir, { recursive: true });
      }

      // 如果原始影片高度小於目標，跳過此畫質
      if (videoInfo.height < quality.height && quality.height > 480) {
        console.log(
          `[HLS] 跳過 ${quality.name}（原始 ${videoInfo.height}p < 目標 ${quality.height}p）`
        );
        resolve({ skipped: true, quality: quality.name });
        return;
      }

      const playlistPath = path.join(qualityDir, 'playlist.m3u8');
      const segmentPattern = path.join(qualityDir, 'segment%03d.ts');

      // 計算目標寬度（保持比例）
      const targetHeight = Math.min(quality.height, videoInfo.height);
      const targetWidth =
        Math.round((videoInfo.width * (targetHeight / videoInfo.height)) / 2) * 2;

      const args = [
        '-i',
        inputPath,
        '-vf',
        `scale=${targetWidth}:${targetHeight}`,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        String(quality.crf),
        '-c:a',
        'aac',
        '-b:a',
        quality.audioBitrate,
        '-hls_time',
        '2',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        segmentPattern,
        '-hls_playlist_type',
        'vod',
        '-y',
        playlistPath,
      ];

      console.log(`[HLS] 開始轉檔 ${quality.name}...`);
      const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          console.error(`[HLS] ${quality.name} 轉檔失敗:`, stderr.slice(-500));
          reject(new Error(`FFmpeg failed for ${quality.name}`));
          return;
        }
        console.log(`[HLS] ${quality.name} 轉檔完成`);
        resolve({ skipped: false, quality: quality.name, playlist: playlistPath });
      });
    });
  }

  /**
   * 產生 master playlist
   */
  generateMasterPlaylist(outputDir, qualities, videoInfo) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];

    for (const q of qualities) {
      // 跳過比原始畫質高的（除了 480p 保底）
      if (videoInfo.height < q.height && q.height > 480) continue;

      const targetHeight = Math.min(q.height, videoInfo.height);
      const targetWidth =
        Math.round((videoInfo.width * (targetHeight / videoInfo.height)) / 2) * 2;
      const bandwidth = parseInt(q.bitrate) * 1000;

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${targetWidth}x${targetHeight},NAME="${q.name}"`
      );
      lines.push(`${q.name}/playlist.m3u8`);
      lines.push('');
    }

    const masterPath = path.join(outputDir, 'master.m3u8');
    fs.writeFileSync(masterPath, lines.join('\n'));
    return masterPath;
  }
}

module.exports = HLSStrategy;
