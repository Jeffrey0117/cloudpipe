/**
 * Maintenance System - 資料維護策略模式
 *
 * 功能：
 * - 定時自動執行維護任務
 * - 按優先級調度策略
 * - 支援手動觸發
 * - 配置持久化
 *
 * 策略優先級：
 * 1. Download - 下載缺失檔案
 * 2. Thumbnail - 生成縮圖
 * 3. Preview - 生成預覽片段
 * 4. HLS - HLS 轉檔
 * 5. Cleanup - 清理原始檔
 */

const MaintenanceScheduler = require('./scheduler');
const MaintenanceStrategy = require('./base-strategy');

// 策略
const DownloadStrategy = require('./strategies/download-strategy');
const ThumbnailStrategy = require('./strategies/thumbnail-strategy');
const PreviewStrategy = require('./strategies/preview-strategy');
const HLSStrategy = require('./strategies/hls-strategy');
const CleanupStrategy = require('./strategies/cleanup-strategy');

module.exports = {
  MaintenanceScheduler,
  MaintenanceStrategy,
  DownloadStrategy,
  ThumbnailStrategy,
  PreviewStrategy,
  HLSStrategy,
  CleanupStrategy,
};
