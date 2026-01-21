/**
 * Workr Client - lurl 用的 workr API 封裝
 */

const WORKR_URL = process.env.WORKR_URL || 'http://localhost:4002';

/**
 * 提交任務到 workr
 */
async function submitJob(type, payload, options = {}) {
  const resp = await fetch(`${WORKR_URL}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      payload,
      priority: options.priority,
      callback: options.callback,
      maxRetries: options.maxRetries
    })
  });

  if (!resp.ok) {
    const error = await resp.json();
    throw new Error(error.error || `Workr API error: ${resp.status}`);
  }

  return resp.json();
}

/**
 * 查詢任務狀態
 */
async function getJob(jobId) {
  const resp = await fetch(`${WORKR_URL}/api/jobs/${jobId}`);
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(`Workr API error: ${resp.status}`);
  }
  return resp.json();
}

/**
 * 等待任務完成
 */
async function waitForJob(jobId, timeoutMs = 60000, pollInterval = 1000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const job = await getJob(jobId);
    if (!job) throw new Error('Job not found');

    if (job.status === 'completed') {
      return { success: true, result: job.result };
    }
    if (job.status === 'failed') {
      return { success: false, error: job.error };
    }
    if (job.status === 'cancelled') {
      return { success: false, error: 'Job was cancelled' };
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error('Job timeout');
}

/**
 * 提交並等待結果
 */
async function submitAndWait(type, payload, options = {}) {
  const { jobId } = await submitJob(type, payload, options);
  return waitForJob(jobId, options.timeout || 60000);
}

// ==================== 便利方法 ====================

/**
 * HLS 轉檔
 */
async function transcodeHLS(inputPath, outputDir, options = {}) {
  return submitJob('hls', { inputPath, outputDir, ...options });
}

/**
 * 下載檔案（繞過 Cloudflare）
 */
async function downloadFile(pageUrl, fileUrl, destPath) {
  return submitJob('download', { pageUrl, fileUrl, destPath });
}

/**
 * 批次下載
 */
async function batchDownload(records, dataDir) {
  return submitJob('download', { records, dataDir });
}

/**
 * 產生縮圖
 */
async function generateThumbnail(videoPath, outputPath, options = {}) {
  return submitJob('thumbnail', {
    videoPath,
    outputPath,
    timestamp: options.timestamp || '00:00:01',
    width: options.width || 320
  });
}

/**
 * WebP 轉換
 */
async function convertToWebp(inputPath, outputPath, options = {}) {
  return submitJob('webp', {
    inputPath,
    outputPath,
    quality: options.quality || 80,
    width: options.width,
    height: options.height
  });
}

module.exports = {
  // 基礎 API
  submitJob,
  getJob,
  waitForJob,
  submitAndWait,

  // 便利方法
  transcodeHLS,
  downloadFile,
  batchDownload,
  generateThumbnail,
  convertToWebp,

  // 設定
  WORKR_URL
};
