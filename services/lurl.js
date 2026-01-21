/**
 * ============================================================================
 * LurlHub - CloudPipe 子專案
 * ============================================================================
 *
 * 【架構說明】
 *
 *   CloudPipe (主平台)
 *   ├── /_admin              ← CloudPipe 主控台（public/admin*.html）
 *   │   └── /_admin/lurlhub  ← LurlHub 概覽（只是快捷入口，不放詳細功能）
 *   │
 *   └── /lurl                ← LurlHub 子專案（本檔案處理所有 /lurl/* 路由）
 *       ├── /lurl/admin      ← LurlHub 管理後台（所有管理功能都在這）
 *       ├── /lurl/browse     ← 公開瀏覽頁
 *       ├── /lurl/login      ← 登入頁
 *       └── /lurl/api/*      ← API 端點
 *
 * 【重要】
 *   - LurlHub 的所有功能都應該在 /lurl/* 底下
 *   - 使用者管理、記錄管理等都應該在 /lurl/admin 用 tab 切換
 *   - /_admin/lurlhub 只是「概覽」，不應放詳細管理功能
 *   - 詳見 docs/architecture.md
 *
 * ============================================================================
 *
 * 【路由總覽】
 *
 * 頁面：
 *   GET  /lurl/admin   - 管理後台（含：記錄、使用者、版本、維護）
 *   GET  /lurl/browse  - 公開瀏覽頁
 *   GET  /lurl/login   - 登入頁
 *   GET  /lurl/health  - 健康檢查
 *
 * API：
 *   POST /lurl/api/rpc         - RPC 統一入口（cb, rc, vr, bl, rd）
 *   POST /lurl/api/capture     - 接收影片/圖片資料
 *   POST /lurl/api/upload      - 分塊上傳
 *   GET  /lurl/api/records     - 記錄列表
 *   GET  /lurl/api/stats       - 統計資料
 *   GET  /lurl/api/users       - 使用者列表
 *   PATCH /lurl/api/users/:id  - 更新使用者
 *
 * 靜態檔案：
 *   GET  /lurl/files/videos/:name      - 影片
 *   GET  /lurl/files/images/:name      - 圖片
 *   GET  /lurl/files/thumbnails/:name  - 縮圖
 *
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');

// 備援下載模組 (Puppeteer - 在頁面 context 下載)
let lurlRetry = null;
try {
  lurlRetry = require('./_lurl-retry');
  console.log('[lurl] ✅ Puppeteer 備援模組已載入');
} catch (e) {
  console.log('[lurl] ⚠️ Puppeteer 備援模組未載入:', e.message);
}

// ==================== 安全配置 ====================
// 從環境變數讀取，請在 .env 檔案中設定
const ADMIN_PASSWORD = process.env.LURL_ADMIN_PASSWORD || 'change-me';
const CLIENT_TOKEN = process.env.LURL_CLIENT_TOKEN || 'change-me';
const SESSION_SECRET = process.env.LURL_SESSION_SECRET || 'change-me';

// 資料存放位置
const DATA_DIR = path.join(__dirname, '..', 'data', 'lurl');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const QUOTAS_FILE = path.join(DATA_DIR, 'quotas.jsonl');
const REDEMPTIONS_FILE = path.join(DATA_DIR, 'redemptions.jsonl');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const HLS_DIR = path.join(DATA_DIR, 'hls');

// HLS 轉檔佇列
const hlsQueue = [];
let hlsProcessing = false;

// 修復服務設定
const FREE_QUOTA = 3;
// VIP 白名單（無限額度），用逗號分隔多個 visitorId
const VIP_WHITELIST = (process.env.LURL_VIP_WHITELIST || '').split(',').filter(Boolean);

// SSE 即時日誌客戶端
const sseClients = new Set();

function broadcastLog(log) {
  const data = `data: ${JSON.stringify(log)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      sseClients.delete(client);
    }
  });
}

// ==================== HLS 轉檔系統 ====================

// 確保 HLS 目錄存在
if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

// HLS 畫質設定
const HLS_QUALITIES = [
  { name: '1080p', height: 1080, bitrate: '5000k', audioBitrate: '192k', crf: 22 },
  { name: '720p', height: 720, bitrate: '2500k', audioBitrate: '128k', crf: 23 },
  { name: '480p', height: 480, bitrate: '1000k', audioBitrate: '96k', crf: 24 }
];

// 取得影片資訊
function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', data => stdout += data);
    ffprobe.stderr.on('data', data => stderr += data);

    ffprobe.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        resolve({
          width: videoStream?.width || 1920,
          height: videoStream?.height || 1080,
          duration: parseFloat(info.format?.duration || 0)
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 單一畫質 HLS 轉檔
function transcodeToHLS(inputPath, outputDir, quality, videoInfo) {
  return new Promise((resolve, reject) => {
    const qualityDir = path.join(outputDir, quality.name);
    if (!fs.existsSync(qualityDir)) {
      fs.mkdirSync(qualityDir, { recursive: true });
    }

    // 如果原始影片高度小於目標，跳過此畫質
    if (videoInfo.height < quality.height && quality.height > 480) {
      console.log(`[HLS] 跳過 ${quality.name}（原始 ${videoInfo.height}p < 目標 ${quality.height}p）`);
      resolve({ skipped: true, quality: quality.name });
      return;
    }

    const playlistPath = path.join(qualityDir, 'playlist.m3u8');
    const segmentPattern = path.join(qualityDir, 'segment%03d.ts');

    // 計算目標寬度（保持比例）
    const targetHeight = Math.min(quality.height, videoInfo.height);
    const targetWidth = Math.round(videoInfo.width * (targetHeight / videoInfo.height) / 2) * 2;

    const args = [
      '-i', inputPath,
      '-vf', `scale=${targetWidth}:${targetHeight}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', String(quality.crf),
      '-c:a', 'aac',
      '-b:a', quality.audioBitrate,
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      '-hls_playlist_type', 'vod',
      '-y',
      playlistPath
    ];

    console.log(`[HLS] 開始轉檔 ${quality.name}...`);
    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';
    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
      // 解析進度
      const timeMatch = stderr.match(/time=(\d+:\d+:\d+\.\d+)/g);
      if (timeMatch) {
        const lastTime = timeMatch[timeMatch.length - 1];
        broadcastLog({ type: 'hls_progress', quality: quality.name, time: lastTime });
      }
    });

    ffmpeg.on('close', code => {
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

// 產生 master.m3u8
function generateMasterPlaylist(outputDir, qualities, videoInfo) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];

  for (const q of qualities) {
    // 跳過比原始畫質高的（除了 480p 保底）
    if (videoInfo.height < q.height && q.height > 480) continue;

    const targetHeight = Math.min(q.height, videoInfo.height);
    const targetWidth = Math.round(videoInfo.width * (targetHeight / videoInfo.height) / 2) * 2;
    const bandwidth = parseInt(q.bitrate) * 1000;

    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${targetWidth}x${targetHeight},NAME="${q.name}"`);
    lines.push(`${q.name}/playlist.m3u8`);
    lines.push('');
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, lines.join('\n'));
  return masterPath;
}

// 完整 HLS 轉檔流程
async function processHLSTranscode(recordId) {
  const records = readAllRecords();
  const record = records.find(r => r.id === recordId);

  if (!record || record.type !== 'video') {
    console.log(`[HLS] 跳過 ${recordId}：非影片或不存在`);
    return { success: false, error: 'Not a video' };
  }

  const inputPath = path.join(DATA_DIR, record.backupPath);
  if (!fs.existsSync(inputPath)) {
    console.log(`[HLS] 跳過 ${recordId}：原始檔案不存在`);
    return { success: false, error: 'Source file not found' };
  }

  const outputDir = path.join(HLS_DIR, recordId);

  // 檢查是否已轉檔
  if (fs.existsSync(path.join(outputDir, 'master.m3u8'))) {
    console.log(`[HLS] 跳過 ${recordId}：已存在 HLS 版本`);
    return { success: true, skipped: true };
  }

  try {
    console.log(`[HLS] 開始處理 ${recordId}...`);
    broadcastLog({ type: 'hls_start', recordId, title: record.title });

    // 取得影片資訊
    const videoInfo = await getVideoInfo(inputPath);
    console.log(`[HLS] 影片資訊: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

    // 建立輸出目錄
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 依序轉檔各畫質（避免同時佔用太多資源）
    const results = [];
    for (const quality of HLS_QUALITIES) {
      try {
        const result = await transcodeToHLS(inputPath, outputDir, quality, videoInfo);
        results.push(result);
      } catch (e) {
        console.error(`[HLS] ${quality.name} 失敗:`, e.message);
        results.push({ skipped: false, quality: quality.name, error: e.message });
      }
    }

    // 產生 master playlist
    generateMasterPlaylist(outputDir, HLS_QUALITIES, videoInfo);

    // 更新記錄
    updateRecord(recordId, { hlsReady: true, hlsPath: `hls/${recordId}/master.m3u8` });

    console.log(`[HLS] ${recordId} 處理完成`);
    broadcastLog({ type: 'hls_complete', recordId, title: record.title });

    return { success: true, results };
  } catch (error) {
    console.error(`[HLS] ${recordId} 處理失敗:`, error);
    broadcastLog({ type: 'hls_error', recordId, error: error.message });
    return { success: false, error: error.message };
  }
}

// HLS 轉檔佇列處理
async function processHLSQueue() {
  if (hlsProcessing || hlsQueue.length === 0) return;

  hlsProcessing = true;

  while (hlsQueue.length > 0) {
    const recordId = hlsQueue.shift();
    try {
      await processHLSTranscode(recordId);
    } catch (e) {
      console.error(`[HLS] 佇列處理錯誤:`, e);
    }
  }

  hlsProcessing = false;
}

// 加入 HLS 轉檔佇列
function queueHLSTranscode(recordId) {
  if (!hlsQueue.includes(recordId)) {
    hlsQueue.push(recordId);
    console.log(`[HLS] 加入佇列: ${recordId}，目前 ${hlsQueue.length} 個待處理`);
    processHLSQueue();
  }
}

// 取得 HLS 狀態
function getHLSStatus() {
  return {
    processing: hlsProcessing,
    queue: hlsQueue.length,
    currentItem: hlsProcessing && hlsQueue.length > 0 ? hlsQueue[0] : null
  };
}

// ==================== 安全函數 ====================

function generateSessionToken(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex').substring(0, 32);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length) {
      cookies[name] = rest.join('=');
    }
  });
  return cookies;
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.lurl_session;
  const validToken = generateSessionToken(ADMIN_PASSWORD);
  return sessionToken === validToken;
}

function isClientAuthenticated(req) {
  const token = req.headers['x-client-token'];
  return token === CLIENT_TOKEN;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl - 登入</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #1a1a2e; padding: 40px; border-radius: 12px; width: 100%; max-width: 360px; }
    .login-box h1 { text-align: center; margin-bottom: 30px; font-size: 1.5em; }
    .login-box input { width: 100%; padding: 12px 16px; border: none; border-radius: 8px; background: #0f0f0f; color: white; font-size: 1em; margin-bottom: 15px; }
    .login-box input:focus { outline: 2px solid #3b82f6; }
    .login-box button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #3b82f6; color: white; font-size: 1em; cursor: pointer; }
    .login-box button:hover { background: #2563eb; }
    .error { color: #f87171; text-align: center; margin-bottom: 15px; font-size: 0.9em; }
    .logo { text-align: center; margin-bottom: 20px; }
    .logo img { height: 60px; }
    .dev-notice { background: linear-gradient(135deg, #1e3a5f, #1a2744); border: 1px solid #3b82f6; border-radius: 8px; padding: 16px; margin-top: 20px; font-size: 0.85em; line-height: 1.6; }
    .dev-notice-title { color: #60a5fa; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .dev-notice-text { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo"><img src="/lurl/files/LOGO.png" alt="Lurl"></div>
    <h1>登入</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/lurl/login">
      <input type="password" name="password" placeholder="請輸入密碼" autofocus required>
      <input type="hidden" name="redirect" value="">
      <button type="submit">登入</button>
    </form>
    <div class="dev-notice">
      <div class="dev-notice-title">🚧 功能開發中</div>
      <div class="dev-notice-text">
        會員系統正在規劃中，目前僅限管理員登入。<br>
        一般用戶請使用免費的救援功能，敬請期待後續更新！
      </div>
    </div>
  </div>
  <script>
    document.querySelector('input[name="redirect"]').value = new URLSearchParams(window.location.search).get('redirect') || '/lurl/browse';
  </script>
</body>
</html>`;
}

// ==================== 工具函數 ====================

function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, IMAGES_DIR, THUMBNAILS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    // 移除所有 emoji（更全面的範圍）
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, '')
    // 移除其他特殊符號
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf._-]/g, '')
    .replace(/_+/g, '_') // 多個底線合併
    .replace(/^_|_$/g, '') // 移除開頭結尾底線
    .substring(0, 200) || `untitled_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

async function downloadFile(url, destPath, pageUrl = '', cookies = '') {
  // 根據 CDN 來源決定 Referer
  // lurl CDN 需要 https://lurl.cc/ 當 referer
  // myppt CDN 需要 https://myppt.cc/ 當 referer
  let baseReferer = 'https://lurl.cc/';
  if (url.includes('myppt.cc')) {
    baseReferer = 'https://myppt.cc/';
  }

  // 策略清單：有 cookie 優先試 cookie
  const strategies = [];

  // 策略 1：用前端傳來的 cookies（最可能成功）
  if (cookies) {
    strategies.push({ referer: baseReferer, cookie: cookies, name: 'cookie+referer' });
  }

  // 策略 2：只用 referer（fallback）
  strategies.push({ referer: baseReferer, cookie: '', name: 'referer-only' });
  if (pageUrl) {
    strategies.push({ referer: pageUrl, cookie: '', name: 'pageUrl-referer' });
  }

  for (const strategy of strategies) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-site',
        'Range': 'bytes=0-',
      };

      if (strategy.referer) {
        headers['Referer'] = strategy.referer;
      }
      if (strategy.cookie) {
        headers['Cookie'] = strategy.cookie;
      }

      console.log(`[lurl] 嘗試下載 (策略: ${strategy.name})`);
      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.log(`[lurl] 策略失敗: HTTP ${response.status}`);
        continue;
      }

      const fileStream = fs.createWriteStream(destPath);
      await pipeline(response.body, fileStream);
      console.log(`[lurl] 下載成功 (策略: ${strategy.name})`);
      return true;
    } catch (err) {
      console.log(`[lurl] 策略錯誤: ${err.message}`);
    }
  }

  console.error(`[lurl] 下載失敗: ${url} (所有策略都失敗)`);
  return false;
}

// 用 ffmpeg 產生影片縮圖
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function generateVideoThumbnail(videoPath, thumbnailPath) {
  try {
    // 確保縮圖目錄存在
    const dir = path.dirname(thumbnailPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ffmpeg 擷取第 1 秒的畫面，輸出 PNG（後續用 sharp 轉 WebP）
    const tempPath = thumbnailPath.replace(/\.\w+$/, '_temp.png');
    const cmd = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${tempPath}"`;
    await execAsync(cmd, { timeout: 30000 });

    if (fs.existsSync(tempPath)) {
      // 用 sharp 轉成 WebP 並壓縮
      await sharp(tempPath)
        .webp({ quality: 75 })
        .toFile(thumbnailPath);

      // 刪除暫存檔
      fs.unlinkSync(tempPath);
      console.log(`[lurl] ✅ 影片縮圖產生成功 (WebP): ${thumbnailPath}`);
      return true;
    }
    return false;
  } catch (err) {
    console.log(`[lurl] ⚠️ 縮圖產生失敗: ${err.message}`);
    return false;
  }
}

// 圖片處理：生成 WebP 縮圖
async function processImage(sourcePath, id) {
  try {
    const thumbDir = THUMBNAILS_DIR;
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }

    const thumbFilename = `${id}.webp`;
    const thumbPath = path.join(thumbDir, thumbFilename);

    // 讀取原圖並生成 320px 寬的 WebP 縮圖
    await sharp(sourcePath)
      .resize(320, null, { withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(thumbPath);

    console.log(`[lurl] ✅ 圖片縮圖產生成功: ${thumbFilename}`);
    return `thumbnails/${thumbFilename}`;
  } catch (err) {
    console.log(`[lurl] ⚠️ 圖片處理失敗: ${err.message}`);
    return null;
  }
}

function appendRecord(record) {
  ensureDirs();
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n', 'utf8');

  // 廣播到 SSE 客戶端
  broadcastLog({
    time: record.capturedAt,
    type: record.backupStatus === 'completed' ? 'upload' : (record.backupStatus === 'failed' ? 'error' : 'view'),
    message: `${record.type === 'video' ? '影片' : '圖片'}: ${record.title || record.pageUrl}`
  });
}

function updateRecordFileUrl(id, newFileUrl) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, fileUrl: newFileUrl };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function updateRecordThumbnail(id, thumbnailPath) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, thumbnailPath };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[lurl] 記錄已更新縮圖: ${id}`);
}

function updateRecordBackupPath(id, backupPath) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, backupPath };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[lurl] 記錄已更新備份路徑: ${id} -> ${backupPath}`);
}

// 通用記錄更新函數
function updateRecord(id, updates) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, ...updates };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[lurl] 記錄已更新: ${id}`, Object.keys(updates));
}

function readAllRecords() {
  ensureDirs();
  if (!fs.existsSync(RECORDS_FILE)) return [];
  const content = fs.readFileSync(RECORDS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

// ==================== 額度管理 ====================

function readAllQuotas() {
  ensureDirs();
  if (!fs.existsSync(QUOTAS_FILE)) return [];
  const content = fs.readFileSync(QUOTAS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function isVipVisitor(visitorId) {
  return VIP_WHITELIST.includes(visitorId);
}

function getVisitorQuota(visitorId) {
  const quotas = readAllQuotas();
  let quota = quotas.find(q => q.visitorId === visitorId);
  if (!quota) {
    quota = {
      visitorId,
      usedCount: 0,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,       // 管理員配發的額度
      status: 'active',    // active | banned | vip
      note: '',            // 管理員備註
      createdAt: new Date().toISOString(),
      history: []
    };
  }
  // 檢查是否在 VIP 白名單
  if (isVipVisitor(visitorId)) {
    quota.status = 'vip';
  }
  return quota;
}

function useQuota(visitorId, pageUrl, urlId, backupUrl) {
  const quotas = readAllQuotas();
  let quotaIndex = quotas.findIndex(q => q.visitorId === visitorId);

  const historyEntry = {
    pageUrl,
    urlId,
    backupUrl,
    usedAt: new Date().toISOString()
  };

  if (quotaIndex === -1) {
    quotas.push({
      visitorId,
      usedCount: 1,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,
      status: 'active',
      note: '',
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      history: [historyEntry]
    });
  } else {
    quotas[quotaIndex].usedCount++;
    quotas[quotaIndex].lastUsed = new Date().toISOString();
    quotas[quotaIndex].history.push(historyEntry);
  }

  fs.writeFileSync(QUOTAS_FILE, quotas.map(q => JSON.stringify(q)).join('\n') + '\n', 'utf8');
  return getVisitorQuota(visitorId);
}

function updateQuota(visitorId, updates) {
  const quotas = readAllQuotas();
  let quotaIndex = quotas.findIndex(q => q.visitorId === visitorId);

  if (quotaIndex === -1) {
    // 如果不存在，先建立
    const newQuota = {
      visitorId,
      usedCount: 0,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,
      status: 'active',
      note: '',
      createdAt: new Date().toISOString(),
      history: [],
      ...updates
    };
    quotas.push(newQuota);
  } else {
    quotas[quotaIndex] = { ...quotas[quotaIndex], ...updates };
  }

  fs.writeFileSync(QUOTAS_FILE, quotas.map(q => JSON.stringify(q)).join('\n') + '\n', 'utf8');
  return getVisitorQuota(visitorId);
}

function deleteQuota(visitorId) {
  const quotas = readAllQuotas().filter(q => q.visitorId !== visitorId);
  fs.writeFileSync(QUOTAS_FILE, quotas.map(q => JSON.stringify(q)).join('\n') + '\n', 'utf8');
}

// 檢查是否已修復過此 URL
function hasRecovered(visitorId, urlId) {
  const quota = getVisitorQuota(visitorId);
  return quota.history.find(h => h.urlId === urlId);
}

function getRemainingQuota(quota) {
  // VIP 或白名單用戶 = 無限額度 (用 -1 代表，因為 Infinity 在 JSON 會變 null)
  if (quota.status === 'vip' || isVipVisitor(quota.visitorId)) {
    return -1;
  }
  // 被封禁 = 0 額度
  if (quota.status === 'banned') {
    return 0;
  }
  return (quota.freeQuota + (quota.bonusQuota || 0)) - quota.usedCount;
}

// ==================== 序號兌換系統 ====================

function generateRedemptionCode() {
  // 格式: XXXX-XXXX-XXXX (12位英數字)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字元 I,O,0,1
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function readAllRedemptions() {
  ensureDirs();
  if (!fs.existsSync(REDEMPTIONS_FILE)) return [];
  const content = fs.readFileSync(REDEMPTIONS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function writeAllRedemptions(redemptions) {
  fs.writeFileSync(REDEMPTIONS_FILE, redemptions.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function getRedemptionCode(code) {
  const redemptions = readAllRedemptions();
  return redemptions.find(r => r.code.toUpperCase() === code.toUpperCase());
}

function createRedemptionCodes(count, bonus, expiresAt = null, note = '') {
  const redemptions = readAllRedemptions();
  const newCodes = [];

  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = generateRedemptionCode();
    } while (redemptions.find(r => r.code === code)); // 確保不重複

    const redemption = {
      code,
      bonus: parseInt(bonus) || 5,
      expiresAt: expiresAt || null,
      usedBy: null,
      usedAt: null,
      createdAt: new Date().toISOString(),
      note: note || ''
    };
    redemptions.push(redemption);
    newCodes.push(redemption);
  }

  writeAllRedemptions(redemptions);
  return newCodes;
}

function redeemCode(code, visitorId) {
  const redemptions = readAllRedemptions();
  const index = redemptions.findIndex(r => r.code.toUpperCase() === code.toUpperCase());

  if (index === -1) {
    return { ok: false, error: '無效的兌換碼' };
  }

  const redemption = redemptions[index];

  // 檢查是否已使用
  if (redemption.usedBy) {
    return { ok: false, error: '此兌換碼已被使用' };
  }

  // 檢查是否過期
  if (redemption.expiresAt && new Date(redemption.expiresAt) < new Date()) {
    return { ok: false, error: '此兌換碼已過期' };
  }

  // 套用額度
  const quota = getVisitorQuota(visitorId);
  const newBonus = (quota.bonusQuota || 0) + redemption.bonus;
  updateQuota(visitorId, { bonusQuota: newBonus });

  // 標記為已使用
  redemption.usedBy = visitorId;
  redemption.usedAt = new Date().toISOString();
  redemptions[index] = redemption;
  writeAllRedemptions(redemptions);

  return { ok: true, bonus: redemption.bonus, newTotal: newBonus };
}

function deleteRedemptionCode(code) {
  const redemptions = readAllRedemptions().filter(r => r.code.toUpperCase() !== code.toUpperCase());
  writeAllRedemptions(redemptions);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx));
  return Object.fromEntries(params);
}

// 從 URL 提取資源 ID（URL 最後一段，去掉 query string，轉小寫）
function extractUrlId(pageUrl) {
  return pageUrl.split('/').pop().split('?')[0].toLowerCase();
}

function corsHeaders(contentType = 'application/json') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Record-Id, X-Chunk-Index, X-Total-Chunks',
    'Content-Type': contentType
  };
}

// ==================== HTML 頁面 ====================

function adminPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: white; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 2em; color: #2196F3; }
    .stat-card p { color: #666; margin-top: 5px; }
    .records { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .record { display: flex; align-items: center; padding: 15px; border-bottom: 1px solid #eee; gap: 15px; }
    .record:hover { background: #f9f9f9; }
    .record-thumb { width: 80px; height: 60px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 24px; background: #f0f0f0; flex-shrink: 0; }
    .record-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .record-thumb.video { background: #e3f2fd; }
    .record-info { flex: 1; min-width: 0; }
    .record-title { font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .record-meta { font-size: 0.85em; color: #999; margin-top: 4px; }
    .record-actions { display: flex; gap: 10px; align-items: center; }
    .record-actions a { color: #2196F3; text-decoration: none; }
    .record-actions .delete-btn { color: #e53935; cursor: pointer; border: none; background: none; font-size: 0.9em; }
    .record-actions .delete-btn:hover { text-decoration: underline; }
    .empty { padding: 40px; text-align: center; color: #999; }
    /* Main Tabs */
    .main-tabs { display: flex; gap: 0; margin-bottom: 24px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .main-tab { padding: 14px 24px; background: transparent; border: none; cursor: pointer; font-size: 0.95em; color: #666; display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    .main-tab:hover { background: #f5f5f5; color: #333; }
    .main-tab.active { background: #2196F3; color: white; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Record Filter Tabs */
    .filter-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .filter-tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .filter-tab.active { background: #2196F3; color: white; }

    /* User Management */
    .user-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .user-stat { background: white; padding: 16px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .user-stat .value { font-size: 1.8em; font-weight: bold; }
    .user-stat .value.green { color: #4caf50; }
    .user-stat .value.orange { color: #ff9800; }
    .user-stat .value.red { color: #f44336; }
    .user-stat .label { font-size: 0.85em; color: #666; margin-top: 4px; }
    .user-list { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .user-item { display: flex; align-items: center; padding: 14px 16px; border-bottom: 1px solid #eee; gap: 12px; cursor: pointer; transition: background 0.2s; }
    .user-item:hover { background: #f9f9f9; }
    .user-item:last-child { border-bottom: none; }
    .user-status-icon { font-size: 1.3em; width: 32px; text-align: center; }
    .user-info { flex: 1; min-width: 0; }
    .user-id { font-family: monospace; font-size: 0.85em; color: #666; }
    .user-note { font-size: 0.75em; color: #999; margin-top: 2px; }
    .user-quota { text-align: center; min-width: 80px; }
    .user-quota .value { font-weight: bold; font-size: 0.95em; }
    .user-quota .label { font-size: 0.7em; color: #888; }
    .user-device { text-align: center; min-width: 70px; font-size: 0.85em; color: #666; }
    .user-time { font-size: 0.8em; color: #999; min-width: 70px; text-align: right; }
    .user-search { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
    .user-search input { flex: 1; max-width: 280px; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.9em; }
    .user-search input:focus { outline: none; border-color: #2196F3; }

    /* Legacy tabs (for record filter) */
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .tab.active { background: #2196F3; color: white; }

    /* Version Management */
    .version-panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 30px; }
    .version-panel h2 { font-size: 1.2em; margin-bottom: 15px; color: #333; display: flex; align-items: center; gap: 8px; }
    .version-form { display: grid; gap: 15px; }
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group label { font-size: 0.85em; color: #666; font-weight: 500; }
    .form-group input, .form-group textarea { padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #2196F3; }
    .form-group textarea { min-height: 60px; resize: vertical; }
    .form-group.checkbox { flex-direction: row; align-items: center; gap: 8px; }
    .form-group.checkbox input { width: auto; }
    .form-actions { display: flex; gap: 10px; margin-top: 10px; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95em; }
    .btn-primary { background: #2196F3; color: white; }
    .btn-primary:hover { background: #1976D2; }
    .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 0.9em; z-index: 1000; animation: slideIn 0.3s ease; }
    .toast.success { background: #4caf50; }
    .toast.error { background: #e53935; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* Maintenance List */
    .maintenance-list { display: flex; flex-direction: column; gap: 8px; }
    .maintenance-item {
      background: #f9f9f9;
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .maintenance-item:hover { background: #f0f0f0; }
    .maintenance-icon { font-size: 1.3em; width: 32px; text-align: center; flex-shrink: 0; }
    .maintenance-info { flex: 1; min-width: 0; }
    .maintenance-label { font-size: 0.9em; color: #333; font-weight: 500; }
    .maintenance-desc { font-size: 0.75em; color: #888; margin-top: 2px; }
    .maintenance-status {
      font-size: 0.8em;
      color: #666;
      min-width: 100px;
      text-align: center;
      padding: 4px 8px;
      background: #e8e8e8;
      border-radius: 4px;
    }
    .maintenance-status.processing { background: #fff3cd; color: #856404; }
    .maintenance-status.success { background: #d4edda; color: #155724; }
    .maintenance-status.error { background: #f8d7da; color: #721c24; }
    .btn-sm { padding: 8px 16px; font-size: 0.85em; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
      <h1>管理面板</h1>
    </div>
    <nav>
      <a href="/lurl/admin" class="active">管理面板</a>
      <a href="/lurl/browse">影片庫</a>
      <a href="/lurl/health">API 狀態</a>
    </nav>
  </div>
  <div class="container">
    <div class="stats" id="stats"></div>

    <!-- 主選項卡 -->
    <div class="main-tabs">
      <button class="main-tab active" data-tab="records">📋 記錄</button>
      <button class="main-tab" data-tab="users">👥 使用者</button>
      <button class="main-tab" data-tab="redemptions">🎁 兌換碼</button>
      <button class="main-tab" data-tab="hls">🎬 HLS</button>
      <button class="main-tab" data-tab="version">📦 版本</button>
      <button class="main-tab" data-tab="maintenance">🔧 維護</button>
    </div>

    <!-- 記錄 Tab -->
    <div class="tab-content active" id="tab-records">
      <div class="tabs">
        <button class="tab active" data-type="all">全部</button>
        <button class="tab" data-type="video">影片</button>
        <button class="tab" data-type="image">圖片</button>
      </div>
      <div class="records" id="records"></div>
    </div>

    <!-- 使用者 Tab -->
    <div class="tab-content" id="tab-users">
      <div class="user-stats">
        <div class="user-stat">
          <div class="value" id="userTotal">-</div>
          <div class="label">總用戶</div>
        </div>
        <div class="user-stat">
          <div class="value green" id="userActive">-</div>
          <div class="label">活躍</div>
        </div>
        <div class="user-stat">
          <div class="value orange" id="userVip">-</div>
          <div class="label">VIP</div>
        </div>
        <div class="user-stat">
          <div class="value red" id="userBanned">-</div>
          <div class="label">封禁</div>
        </div>
      </div>
      <!-- 序號搜尋 -->
      <div class="user-search">
        <input type="text" id="userSearchInput" placeholder="🔍 輸入序號搜尋（如 V_1ABC）" maxlength="20">
        <button class="btn btn-primary btn-sm" onclick="searchUserByCode()">搜尋</button>
        <button class="btn btn-sm" onclick="clearUserSearch()" style="background:#e0e0e0;">清除</button>
      </div>
      <div class="user-list" id="userList">
        <div class="empty">載入中...</div>
      </div>
    </div>

    <!-- 使用者編輯 Modal -->
    <div id="userModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center;">
      <div style="background:white; border-radius:12px; padding:24px; max-width:450px; width:90%; max-height:80vh; overflow-y:auto;">
        <h3 style="margin:0 0 20px 0;">👤 管理用戶</h3>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">用戶 ID</label>
          <div id="modalUserId" style="font-family:monospace; background:#f5f5f5; padding:8px; border-radius:4px; word-break:break-all; font-size:0.85em;"></div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:15px;">
          <div style="background:#f9f9f9; padding:12px; border-radius:8px;">
            <div style="font-size:0.75em; color:#888;">額度狀態</div>
            <div id="modalQuotaInfo" style="font-size:1.1em; font-weight:bold; margin-top:4px;">-</div>
          </div>
          <div style="background:#f9f9f9; padding:12px; border-radius:8px;">
            <div style="font-size:0.75em; color:#888;">最後上線</div>
            <div id="modalLastSeen" style="font-size:0.9em; margin-top:4px;">-</div>
          </div>
        </div>
        <div style="background:#f9f9f9; padding:12px; border-radius:8px; margin-bottom:15px;">
          <div style="font-size:0.75em; color:#888; margin-bottom:8px;">設備資訊</div>
          <div id="modalDeviceInfo" style="font-size:0.85em; display:grid; grid-template-columns:1fr 1fr; gap:6px;">-</div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">備註</label>
          <input type="text" id="modalNote" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;" placeholder="添加備註...">
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">配發額度</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(5)">+5</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(10)">+10</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(20)">+20</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(50)">+50</button>
          </div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">狀態操作</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn btn-sm" style="background:#4caf50; color:white;" onclick="setUserStatus('active')">✅ 正常</button>
            <button class="btn btn-sm" style="background:#ff9800; color:white;" onclick="setUserStatus('vip')">⭐ VIP</button>
            <button class="btn btn-sm" style="background:#f44336; color:white;" onclick="setUserStatus('banned')">🚫 封禁</button>
          </div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">使用歷史 (最近 5 筆)</label>
          <div id="modalHistory" style="font-size:0.85em; background:#f9f9f9; padding:10px; border-radius:4px; max-height:120px; overflow-y:auto;"></div>
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button class="btn" style="background:#e0e0e0;" onclick="closeUserModal()">關閉</button>
          <button class="btn btn-primary" onclick="saveUserChanges()">儲存</button>
        </div>
      </div>
    </div>

    <!-- 兌換碼 Tab -->
    <div class="tab-content" id="tab-redemptions">
      <div class="user-stats" style="margin-bottom:20px;">
        <div class="user-stat">
          <div class="value" id="redemptionTotal">-</div>
          <div class="label">總數</div>
        </div>
        <div class="user-stat">
          <div class="value green" id="redemptionUnused">-</div>
          <div class="label">未使用</div>
        </div>
        <div class="user-stat">
          <div class="value orange" id="redemptionUsed">-</div>
          <div class="label">已使用</div>
        </div>
        <div class="user-stat">
          <div class="value red" id="redemptionExpired">-</div>
          <div class="label">已過期</div>
        </div>
      </div>

      <!-- 生成兌換碼 -->
      <div class="version-panel" style="margin-bottom:20px;">
        <h2>🎁 生成兌換碼</h2>
        <div class="version-form">
          <div class="form-row">
            <div class="form-group">
              <label>數量</label>
              <input type="number" id="genCount" value="10" min="1" max="100">
            </div>
            <div class="form-group">
              <label>每個額度</label>
              <input type="number" id="genBonus" value="5" min="1" max="100">
            </div>
            <div class="form-group">
              <label>有效期限（留空=無限期）</label>
              <input type="date" id="genExpiry">
            </div>
          </div>
          <div class="form-group">
            <label>備註</label>
            <input type="text" id="genNote" placeholder="例：新年活動、社群回饋">
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" onclick="generateCodes()">🎲 生成</button>
          </div>
        </div>
      </div>

      <!-- 兌換碼列表 -->
      <div class="version-panel">
        <h2>📋 兌換碼列表</h2>
        <div style="margin-bottom:12px; display:flex; gap:8px; align-items:center;">
          <select id="redemptionFilter" onchange="loadRedemptions()" style="padding:8px 12px; border:1px solid #ddd; border-radius:6px;">
            <option value="all">全部</option>
            <option value="unused">未使用</option>
            <option value="used">已使用</option>
            <option value="expired">已過期</option>
          </select>
          <button class="btn btn-sm" style="background:#e0e0e0;" onclick="copyUnusedCodes()">📋 複製未使用</button>
        </div>
        <div id="redemptionsList" style="max-height:400px; overflow-y:auto;">載入中...</div>
      </div>
    </div>

    <!-- HLS Tab -->
    <div class="tab-content" id="tab-hls">
      <div class="version-panel" style="margin-bottom:20px;">
        <h2>🎬 HLS 串流轉檔</h2>
        <p style="color:#666; margin-bottom:20px;">將影片轉換為多畫質 HLS 串流格式，支援自適應畫質切換，大幅改善播放體驗。</p>

        <!-- HLS 統計 -->
        <div class="user-stats" style="grid-template-columns: repeat(4, 1fr); margin-bottom:20px;">
          <div class="user-stat">
            <div class="value" id="hlsTotal">-</div>
            <div class="label">影片總數</div>
          </div>
          <div class="user-stat">
            <div class="value green" id="hlsReady">-</div>
            <div class="label">已轉檔</div>
          </div>
          <div class="user-stat">
            <div class="value orange" id="hlsPending">-</div>
            <div class="label">待轉檔</div>
          </div>
          <div class="user-stat">
            <div class="value" id="hlsQueue">-</div>
            <div class="label">佇列中</div>
          </div>
        </div>

        <!-- 操作按鈕 -->
        <div style="display:flex; gap:12px; margin-bottom:20px;">
          <button class="btn btn-primary" onclick="transcodeAllHLS()">🚀 全部轉檔</button>
          <button class="btn" style="background:#e0e0e0;" onclick="refreshHLSStats()">🔄 刷新狀態</button>
        </div>

        <!-- 轉檔進度 -->
        <div id="hlsProgress" style="display:none; background:#f5f5f5; padding:15px; border-radius:8px; margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
            <span id="hlsProgressTitle">轉檔中...</span>
            <span id="hlsProgressTime">00:00:00</span>
          </div>
          <div style="background:#ddd; height:8px; border-radius:4px; overflow:hidden;">
            <div id="hlsProgressBar" style="background:#4caf50; height:100%; width:0%; transition:width 0.3s;"></div>
          </div>
        </div>

        <!-- 未轉檔列表 -->
        <h3 style="margin-bottom:12px;">待轉檔影片</h3>
        <div class="records" id="hlsPendingList" style="max-height:400px; overflow-y:auto;">
          <div class="empty">載入中...</div>
        </div>
      </div>
    </div>

    <!-- 版本 Tab -->
    <div class="tab-content" id="tab-version">
      <div class="version-panel" style="margin-bottom:0;">
        <h2>📦 腳本版本管理</h2>
        <div class="version-form">
          <div class="form-row">
            <div class="form-group">
              <label>最新版本 (latestVersion)</label>
              <input type="text" id="latestVersion" placeholder="例: 4.8">
            </div>
            <div class="form-group">
              <label>最低版本 (minVersion) - 低於此版本強制更新</label>
              <input type="text" id="minVersion" placeholder="例: 4.0.0">
            </div>
          </div>
          <div class="form-group">
            <label>更新訊息 (message)</label>
            <input type="text" id="versionMessage" placeholder="例: 新增功能、修復問題等">
          </div>
          <div class="form-group">
            <label>公告 (announcement) - 可選</label>
            <textarea id="announcement" placeholder="額外公告訊息..."></textarea>
          </div>
          <div class="form-group">
            <label>更新連結 (updateUrl)</label>
            <input type="text" id="updateUrl" placeholder="GitHub raw URL">
          </div>
          <div class="form-group checkbox">
            <input type="checkbox" id="forceUpdate">
            <label for="forceUpdate">強制更新 (forceUpdate) - 所有舊版本必須更新</label>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" onclick="saveVersionConfig()">💾 儲存設定</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 維護 Tab -->
    <div class="tab-content" id="tab-maintenance">
      <div class="version-panel" style="margin-bottom:0;">
        <h2>🔧 資料維護</h2>
        <div class="maintenance-list">
          <div class="maintenance-item">
            <div class="maintenance-icon">🔧</div>
            <div class="maintenance-info">
              <div class="maintenance-label">修復 Untitled</div>
              <div class="maintenance-desc">重新抓取缺少標題的記錄</div>
            </div>
            <div class="maintenance-status" id="untitledStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="fixUntitled()">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🔄</div>
            <div class="maintenance-info">
              <div class="maintenance-label">重試下載</div>
              <div class="maintenance-desc">用 Puppeteer 重新下載失敗的檔案</div>
            </div>
            <div class="maintenance-status" id="retryStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="retryFailed()" id="retryBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🖼️</div>
            <div class="maintenance-info">
              <div class="maintenance-label">產生縮圖</div>
              <div class="maintenance-desc">為沒有縮圖的影片產生預覽圖</div>
            </div>
            <div class="maintenance-status" id="thumbStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="generateThumbnails()" id="thumbBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🗑️</div>
            <div class="maintenance-info">
              <div class="maintenance-label">清理重複</div>
              <div class="maintenance-desc">移除重複的 pageUrl/fileUrl 記錄</div>
            </div>
            <div class="maintenance-status" id="dupStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="cleanupDuplicates()" id="dupBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">📁</div>
            <div class="maintenance-info">
              <div class="maintenance-label">修復路徑</div>
              <div class="maintenance-desc">修正指向同一檔案的記錄</div>
            </div>
            <div class="maintenance-status" id="repairStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="repairPaths()" id="repairBtn">執行</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let allRecords = [];
    let currentType = 'all';
    let allUsers = [];
    let currentUser = null;

    // ===== 主 Tab 切換 =====
    document.querySelectorAll('.main-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        switchMainTab(targetTab);
      });
    });

    function switchMainTab(tabName) {
      // 更新 tab 樣式
      document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
      document.querySelector(\`.main-tab[data-tab="\${tabName}"]\`).classList.add('active');

      // 顯示對應內容
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tabName).classList.add('active');

      // 更新 URL hash
      history.replaceState(null, '', '#' + tabName);

      // 載入資料
      if (tabName === 'users') loadUsers();
      if (tabName === 'redemptions') loadRedemptions();
      if (tabName === 'hls') refreshHLSStats();
    }

    // 根據 URL hash 切換 tab
    function checkHashAndSwitch() {
      const hash = window.location.hash.replace('#', '') || 'records';
      if (['records', 'users', 'redemptions', 'hls', 'version', 'maintenance'].includes(hash)) {
        switchMainTab(hash);
      }
    }
    window.addEventListener('hashchange', checkHashAndSwitch);

    // ===== 使用者管理 =====
    async function loadUsers() {
      try {
        const res = await fetch('/lurl/api/users');
        const data = await res.json();
        if (data.ok) {
          allUsers = data.users;
          renderUserStats();
          renderUserList();
        }
      } catch (e) {
        document.getElementById('userList').innerHTML = '<div class="empty">載入失敗</div>';
      }
    }

    function renderUserStats() {
      const total = allUsers.length;
      const active = allUsers.filter(u => u.status === 'active').length;
      const vip = allUsers.filter(u => u.status === 'vip' || u.isVip).length;
      const banned = allUsers.filter(u => u.status === 'banned').length;

      document.getElementById('userTotal').textContent = total;
      document.getElementById('userActive').textContent = active;
      document.getElementById('userVip').textContent = vip;
      document.getElementById('userBanned').textContent = banned;
    }

    function renderUserList() {
      if (allUsers.length === 0) {
        document.getElementById('userList').innerHTML = '<div class="empty">尚無用戶</div>';
        return;
      }

      // 根據搜尋過濾
      let filtered = allUsers;
      if (searchQuery) {
        filtered = allUsers.filter(u => u.visitorId.toUpperCase().startsWith(searchQuery));
      }

      if (filtered.length === 0) {
        document.getElementById('userList').innerHTML = '<div class="empty">找不到符合「' + searchQuery + '」的用戶</div>';
        return;
      }

      const html = filtered.map(u => {
        const statusIcon = u.status === 'banned' ? '🔴' : (u.status === 'vip' || u.isVip ? '⭐' : '🟢');
        const remaining = u.remaining === -1 ? '∞' : u.remaining;
        const remainingColor = u.remaining === -1 ? 'color:#ff9800' : (u.remaining <= 0 ? 'color:#f44336' : 'color:#4caf50');
        const lastSeen = u.device?.lastSeen ? timeAgo(u.device.lastSeen) : '-';
        const network = u.device?.network?.type?.toUpperCase() || '-';
        // 顯示序號（前6位大寫）方便核對
        const shortCode = u.visitorId.substring(0, 6).toUpperCase();

        return \`<div class="user-item" onclick="openUserModal('\${u.visitorId}')">
          <div class="user-status-icon">\${statusIcon}</div>
          <div class="user-info">
            <div class="user-id"><span style="background:#e3f2fd;padding:2px 6px;border-radius:4px;font-weight:bold;color:#1976d2;">\${shortCode}</span> \${u.visitorId.substring(6, 20)}...</div>
            <div class="user-note">\${u.note || '無備註'}</div>
          </div>
          <div class="user-quota">
            <div class="value" style="\${remainingColor}">\${u.usedCount}/\${u.total}</div>
            <div class="label">已用/總額</div>
          </div>
          <div class="user-device">\${network}</div>
          <div class="user-time">\${lastSeen}</div>
        </div>\`;
      }).join('');

      document.getElementById('userList').innerHTML = html;
    }

    // 序號搜尋
    let searchQuery = '';
    function searchUserByCode() {
      const input = document.getElementById('userSearchInput').value.trim().toUpperCase();
      if (!input) return;
      searchQuery = input;
      renderUserList();
    }

    function clearUserSearch() {
      searchQuery = '';
      document.getElementById('userSearchInput').value = '';
      renderUserList();
    }

    // Enter 搜尋
    document.getElementById('userSearchInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') searchUserByCode();
    });

    function openUserModal(visitorId) {
      currentUser = allUsers.find(u => u.visitorId === visitorId);
      if (!currentUser) return;

      const u = currentUser;
      document.getElementById('modalUserId').textContent = u.visitorId;

      // 額度資訊
      const remaining = u.remaining === -1 ? '∞' : u.remaining;
      const statusText = u.status === 'banned' ? '🔴封禁' : (u.status === 'vip' || u.isVip ? '⭐VIP' : '🟢正常');
      document.getElementById('modalQuotaInfo').innerHTML = \`\${statusText}<br><span style="font-size:0.8em;color:#666;">\${u.usedCount}/\${u.total} (剩:\${remaining})</span>\`;

      // 最後上線
      const lastSeen = u.device?.lastSeen ? new Date(u.device.lastSeen).toLocaleString() : (u.lastActive ? new Date(u.lastActive).toLocaleString() : '-');
      document.getElementById('modalLastSeen').textContent = lastSeen;

      // 設備資訊 (grid layout)
      const d = u.device || {};
      const deviceItems = [];

      // 網路
      if (d.network?.type) deviceItems.push({ label: '網路', value: d.network.type.toUpperCase() });
      if (d.network?.downlink) deviceItems.push({ label: '頻寬', value: d.network.downlink + ' Mbps' });
      if (d.network?.rtt) deviceItems.push({ label: '延遲', value: d.network.rtt + ' ms' });

      // 硬體
      if (d.hardware?.cores) deviceItems.push({ label: 'CPU', value: d.hardware.cores + ' 核心' });
      if (d.hardware?.memory) deviceItems.push({ label: '記憶體', value: d.hardware.memory + ' GB' });

      // 電池
      if (d.battery?.level != null) {
        const batteryPct = Math.round(d.battery.level * 100);
        const charging = d.battery.charging ? '⚡' : '';
        deviceItems.push({ label: '電量', value: batteryPct + '%' + charging });
      }

      // 測速結果
      if (d.speedTest?.mbps) {
        const testedAt = d.speedTest.testedAt ? new Date(d.speedTest.testedAt).toLocaleString() : '';
        deviceItems.push({ label: '實測速度', value: d.speedTest.mbps.toFixed(1) + ' Mbps' });
        if (testedAt) deviceItems.push({ label: '測速時間', value: testedAt });
      }

      if (deviceItems.length === 0) {
        document.getElementById('modalDeviceInfo').innerHTML = '<span style="color:#999;">無設備資訊</span>';
      } else {
        document.getElementById('modalDeviceInfo').innerHTML = deviceItems.map(item =>
          \`<div><span style="color:#888;">\${item.label}:</span> \${item.value}</div>\`
        ).join('');
      }

      document.getElementById('modalNote').value = u.note || '';

      // 歷史
      const history = (u.history || []).slice(-5).reverse();
      if (history.length === 0) {
        document.getElementById('modalHistory').innerHTML = '<div style="color:#999;">無使用記錄</div>';
      } else {
        document.getElementById('modalHistory').innerHTML = history.map(h => \`
          <div style="padding:4px 0; border-bottom:1px solid #eee;">
            <div style="color:#333; font-size:0.85em;">\${h.pageUrl ? h.pageUrl.substring(0, 40) + '...' : '未知'}</div>
            <div style="color:#888; font-size:0.75em;">\${new Date(h.usedAt).toLocaleString()}</div>
          </div>
        \`).join('');
      }

      document.getElementById('userModal').style.display = 'flex';
    }

    function closeUserModal() {
      document.getElementById('userModal').style.display = 'none';
      currentUser = null;
    }

    async function addUserQuota(amount) {
      if (!currentUser) return;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addBonus: amount })
        });
        if ((await res.json()).ok) {
          showToast('已配發 +' + amount + ' 額度', 'success');
          await loadUsers();
          currentUser = allUsers.find(u => u.visitorId === currentUser.visitorId);
          if (currentUser) openUserModal(currentUser.visitorId);
        }
      } catch (e) {
        showToast('配發失敗', 'error');
      }
    }

    async function setUserStatus(status) {
      if (!currentUser) return;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if ((await res.json()).ok) {
          const statusText = status === 'banned' ? '已封禁' : (status === 'vip' ? '已設為 VIP' : '已恢復正常');
          showToast(statusText, 'success');
          await loadUsers();
          closeUserModal();
        }
      } catch (e) {
        showToast('操作失敗', 'error');
      }
    }

    async function saveUserChanges() {
      if (!currentUser) return;
      const note = document.getElementById('modalNote').value;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note })
        });
        if ((await res.json()).ok) {
          showToast('已儲存', 'success');
          await loadUsers();
          closeUserModal();
        }
      } catch (e) {
        showToast('儲存失敗', 'error');
      }
    }

    // Modal 背景點擊關閉
    document.getElementById('userModal').addEventListener('click', function(e) {
      if (e.target === this) closeUserModal();
    });

    function timeAgo(timestamp) {
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return '剛剛';
      if (seconds < 3600) return Math.floor(seconds / 60) + '分鐘前';
      if (seconds < 86400) return Math.floor(seconds / 3600) + '小時前';
      return Math.floor(seconds / 86400) + '天前';
    }

    // ===== 兌換碼管理 =====
    let allRedemptions = [];

    async function loadRedemptions() {
      try {
        const res = await fetch('/lurl/api/redemptions');
        const data = await res.json();
        if (data.ok) {
          allRedemptions = data.redemptions;
          renderRedemptionStats(data.stats);
          renderRedemptionsList();
        }
      } catch (e) {
        document.getElementById('redemptionsList').innerHTML = '<div class="empty">載入失敗</div>';
      }
    }

    function renderRedemptionStats(stats) {
      document.getElementById('redemptionTotal').textContent = stats.total;
      document.getElementById('redemptionUnused').textContent = stats.unused;
      document.getElementById('redemptionUsed').textContent = stats.used;
      document.getElementById('redemptionExpired').textContent = stats.expired;
    }

    function renderRedemptionsList() {
      const filter = document.getElementById('redemptionFilter').value;
      let filtered = allRedemptions;

      if (filter === 'unused') {
        filtered = allRedemptions.filter(r => !r.usedBy && (!r.expiresAt || new Date(r.expiresAt) > new Date()));
      } else if (filter === 'used') {
        filtered = allRedemptions.filter(r => r.usedBy);
      } else if (filter === 'expired') {
        filtered = allRedemptions.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date() && !r.usedBy);
      }

      if (filtered.length === 0) {
        document.getElementById('redemptionsList').innerHTML = '<div class="empty">無兌換碼</div>';
        return;
      }

      // 表頭
      let html = \`<div class="user-item" style="cursor:default; background:#f5f5f5; font-weight:500; font-size:0.85em; color:#666;">
        <div style="min-width:140px;">兌換碼</div>
        <div style="min-width:50px; text-align:center;">額度</div>
        <div style="min-width:70px; text-align:center;">期限</div>
        <div style="min-width:55px; text-align:center;">狀態</div>
        <div style="min-width:100px; text-align:center;">兌換者</div>
        <div style="min-width:90px; text-align:center;">兌換日期</div>
        <div style="flex:1;">備註</div>
        <div style="min-width:50px;"></div>
      </div>\`;

      html += filtered.map(r => {
        const isUsed = !!r.usedBy;
        const isExpired = r.expiresAt && new Date(r.expiresAt) < new Date();
        const statusColor = isUsed ? '#ff9800' : (isExpired ? '#f44336' : '#4caf50');
        const statusText = isUsed ? '已使用' : (isExpired ? '已過期' : '可使用');
        const expiryText = r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('zh-TW') : '永久';
        const usedByShort = r.usedBy ? r.usedBy.substring(0, 8).toUpperCase() : '-';
        const usedAtText = r.usedAt ? new Date(r.usedAt).toLocaleString('zh-TW') : '-';

        return \`<div class="user-item" style="cursor:default;">
          <div style="font-family:monospace; font-weight:bold; color:#1976d2; min-width:140px;">\${r.code}</div>
          <div style="min-width:50px; text-align:center;">+\${r.bonus}</div>
          <div style="min-width:70px; text-align:center; font-size:0.85em; color:#666;">\${expiryText}</div>
          <div style="min-width:55px; text-align:center; color:\${statusColor}; font-size:0.85em;">\${statusText}</div>
          <div style="min-width:100px; text-align:center;">
            \${r.usedBy
              ? \`<span style="background:#e3f2fd; padding:2px 6px; border-radius:4px; font-size:0.8em; font-family:monospace; cursor:pointer; color:#1976d2;" onclick="jumpToUser('\${r.usedBy}')" title="點擊查看用戶 \${r.usedBy}">\${usedByShort}</span>\`
              : '<span style="color:#999; font-size:0.8em;">-</span>'}
          </div>
          <div style="min-width:90px; text-align:center; font-size:0.75em; color:#888;">\${r.usedAt ? new Date(r.usedAt).toLocaleDateString('zh-TW') : '-'}</div>
          <div style="flex:1; font-size:0.8em; color:#999; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${r.note || '-'}</div>
          <div style="min-width:50px; text-align:right;">
            <button class="btn btn-sm" style="background:#e53935; color:white; padding:4px 8px;" onclick="deleteRedemption('\${r.code}')">刪除</button>
          </div>
        </div>\`;
      }).join('');

      document.getElementById('redemptionsList').innerHTML = html;
    }

    async function generateCodes() {
      const count = parseInt(document.getElementById('genCount').value) || 10;
      const bonus = parseInt(document.getElementById('genBonus').value) || 5;
      const expiresAt = document.getElementById('genExpiry').value || null;
      const note = document.getElementById('genNote').value || '';

      try {
        const res = await fetch('/lurl/api/redemptions/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count, bonus, expiresAt, note })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('已生成 ' + data.codes.length + ' 個兌換碼', 'success');
          loadRedemptions();
        } else {
          showToast(data.error || '生成失敗', 'error');
        }
      } catch (e) {
        showToast('生成失敗：' + e.message, 'error');
      }
    }

    async function deleteRedemption(code) {
      if (!confirm('確定刪除此兌換碼？')) return;
      try {
        await fetch('/lurl/api/redemptions/' + encodeURIComponent(code), { method: 'DELETE' });
        showToast('已刪除', 'success');
        loadRedemptions();
      } catch (e) {
        showToast('刪除失敗', 'error');
      }
    }

    function copyUnusedCodes() {
      const unused = allRedemptions.filter(r => !r.usedBy && (!r.expiresAt || new Date(r.expiresAt) > new Date()));
      if (unused.length === 0) {
        showToast('無可用兌換碼', 'error');
        return;
      }
      const codes = unused.map(r => r.code).join('\\n');
      navigator.clipboard.writeText(codes).then(() => {
        showToast('已複製 ' + unused.length + ' 個兌換碼', 'success');
      });
    }

    // 從兌換碼列表跳轉到用戶
    async function jumpToUser(visitorId) {
      // 切換到用戶 tab
      switchMainTab('users');
      // 等待用戶列表載入
      await loadUsers();
      // 搜尋該用戶
      const shortCode = visitorId.substring(0, 6).toUpperCase();
      document.getElementById('userSearchInput').value = shortCode;
      searchQuery = shortCode;
      renderUserList();
      // 如果找到，直接開啟 modal
      const user = allUsers.find(u => u.visitorId === visitorId);
      if (user) {
        openUserModal(visitorId);
      }
    }

    // ==================== HLS 管理 ====================
    let hlsRecords = [];

    async function refreshHLSStats() {
      try {
        // 取得記錄
        const recordsRes = await fetch('/lurl/api/records');
        const recordsData = await recordsRes.json();
        const videos = recordsData.records.filter(r => r.type === 'video' && r.fileExists !== false);
        hlsRecords = videos;

        // 取得 HLS 佇列狀態
        const statusRes = await fetch('/lurl/api/hls/status');
        const status = await statusRes.json();

        const hlsReadyCount = videos.filter(r => r.hlsReady).length;
        const hlsPendingCount = videos.filter(r => !r.hlsReady).length;

        document.getElementById('hlsTotal').textContent = videos.length;
        document.getElementById('hlsReady').textContent = hlsReadyCount;
        document.getElementById('hlsPending').textContent = hlsPendingCount;
        document.getElementById('hlsQueue').textContent = status.queue;

        // 顯示進度
        if (status.processing) {
          document.getElementById('hlsProgress').style.display = 'block';
        } else {
          document.getElementById('hlsProgress').style.display = 'none';
        }

        // 渲染待轉檔列表
        renderHLSPendingList();
      } catch (e) {
        console.error('載入 HLS 狀態失敗:', e);
      }
    }

    function renderHLSPendingList() {
      const pending = hlsRecords.filter(r => !r.hlsReady);
      if (pending.length === 0) {
        document.getElementById('hlsPendingList').innerHTML = '<div class="empty">🎉 所有影片已轉檔完成！</div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? '未命名' : t;
      document.getElementById('hlsPendingList').innerHTML = pending.slice(0, 50).map(r => \`
        <div class="record" data-id="\${r.id}">
          <div class="record-thumb video">🎬</div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            <button class="btn btn-sm btn-primary" onclick="transcodeOne('\${r.id}')">轉檔</button>
          </div>
        </div>
      \`).join('');
    }

    async function transcodeOne(recordId) {
      try {
        showToast('已加入轉檔佇列...', 'success');
        await fetch('/lurl/api/hls/transcode/' + recordId, { method: 'POST' });
        setTimeout(refreshHLSStats, 1000);
      } catch (e) {
        showToast('加入佇列失敗', 'error');
      }
    }

    async function transcodeAllHLS() {
      if (!confirm('確定要轉檔所有未處理的影片？這可能需要較長時間。')) return;
      try {
        const res = await fetch('/lurl/api/hls/transcode-all', { method: 'POST' });
        const data = await res.json();
        showToast('已加入 ' + data.queued + ' 個影片到轉檔佇列', 'success');
        document.getElementById('hlsProgress').style.display = 'block';
        setTimeout(refreshHLSStats, 2000);
      } catch (e) {
        showToast('批次轉檔失敗', 'error');
      }
    }

    // 監聽 HLS 進度 (SSE)
    function listenHLSProgress() {
      const eventSource = new EventSource('/lurl/api/logs');
      eventSource.onmessage = function(event) {
        try {
          const log = JSON.parse(event.data);
          if (log.type === 'hls_progress') {
            document.getElementById('hlsProgressTitle').textContent = '轉檔 ' + log.quality + '...';
            document.getElementById('hlsProgressTime').textContent = log.time || '';
          } else if (log.type === 'hls_complete') {
            showToast('轉檔完成: ' + (log.title || log.recordId), 'success');
            refreshHLSStats();
          } else if (log.type === 'hls_start') {
            document.getElementById('hlsProgress').style.display = 'block';
            document.getElementById('hlsProgressTitle').textContent = '開始轉檔: ' + (log.title || log.recordId);
          }
        } catch (e) {}
      };
    }

    // 設定維護狀態的 helper
    function setStatus(id, text, type = '') {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'maintenance-status' + (type ? ' ' + type : '');
    }

    async function loadStats() {
      const res = await fetch('/lurl/api/stats');
      const data = await res.json();
      document.getElementById('stats').innerHTML = \`
        <div class="stat-card"><h3>\${data.total}</h3><p>總記錄</p></div>
        <div class="stat-card"><h3>\${data.videos}</h3><p>影片</p></div>
        <div class="stat-card"><h3>\${data.images}</h3><p>圖片</p></div>
      \`;
    }

    async function loadRecords() {
      const res = await fetch('/lurl/api/records');
      const data = await res.json();
      allRecords = data.records;
      renderRecords();
    }

    function renderRecords() {
      const filtered = currentType === 'all' ? allRecords : allRecords.filter(r => r.type === currentType);
      if (filtered.length === 0) {
        document.getElementById('records').innerHTML = '<div class="empty">尚無記錄</div>';
        return;
      }
      const getTitle = (t) => (!t || t === 'untitle' || t === 'undefined') ? '未命名' : t;
      document.getElementById('records').innerHTML = filtered.map(r => \`
        <div class="record" data-id="\${r.id}">
          <div class="record-thumb \${r.type}">
            \${r.type === 'image'
              ? \`<img src="/lurl/files/\${r.backupPath}" onerror="this.outerHTML='🖼️'">\`
              : (r.fileExists ? '🎬' : '⏳')}
          </div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}\${r.fileExists ? '' : ' <span style="color:#e53935;font-size:0.8em">(未備份)</span>'}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            \${r.fileExists ? \`<a href="/lurl/files/\${r.backupPath}" target="_blank">查看</a>\` : ''}
            <a href="/lurl/view/\${r.id}">詳情</a>
            <a href="\${r.pageUrl}" target="_blank">原始</a>
            <button class="delete-btn" onclick="deleteRecord('\${r.id}')">刪除</button>
          </div>
        </div>
      \`).join('');
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        renderRecords();
      });
    });

    async function deleteRecord(id) {
      if (!confirm('確定要刪除這筆記錄？')) return;
      const res = await fetch('/lurl/api/records/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        loadStats();
        loadRecords();
      } else {
        alert('刪除失敗: ' + (data.error || '未知錯誤'));
      }
    }

    // Toast 訊息
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    // 版本設定
    async function loadVersionConfig() {
      try {
        const res = await fetch('/lurl/api/version');
        const config = await res.json();
        document.getElementById('latestVersion').value = config.latestVersion || '';
        document.getElementById('minVersion').value = config.minVersion || '';
        document.getElementById('versionMessage').value = config.message || '';
        document.getElementById('announcement').value = config.announcement || '';
        document.getElementById('updateUrl').value = config.updateUrl || '';
        document.getElementById('forceUpdate').checked = config.forceUpdate || false;
      } catch (e) {
        console.error('載入版本設定失敗:', e);
      }
    }

    async function saveVersionConfig() {
      const config = {
        latestVersion: document.getElementById('latestVersion').value,
        minVersion: document.getElementById('minVersion').value,
        message: document.getElementById('versionMessage').value,
        announcement: document.getElementById('announcement').value,
        updateUrl: document.getElementById('updateUrl').value,
        forceUpdate: document.getElementById('forceUpdate').checked
      };
      try {
        const res = await fetch('/lurl/api/version', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.ok) {
          showToast('版本設定已儲存！');
        } else {
          showToast('儲存失敗: ' + (data.error || '未知錯誤'), 'error');
        }
      } catch (e) {
        showToast('儲存失敗: ' + e.message, 'error');
      }
    }

    async function fixUntitled() {
      setStatus('untitledStatus', '修復中...', 'processing');
      try {
        const res = await fetch('/lurl/api/fix-untitled', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.fixed > 0) {
            showToast('已修復 ' + data.fixed + ' 個 untitled 記錄！');
            setStatus('untitledStatus', '已修復 ' + data.fixed + ' 筆', 'success');
            loadRecords();
          } else {
            showToast(data.message || '沒有需要修復的記錄');
            setStatus('untitledStatus', '無需修復', 'success');
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('untitledStatus', '修復失敗', 'error');
        }
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        setStatus('untitledStatus', '修復失敗', 'error');
      }
    }

    async function loadRetryStatus() {
      try {
        const res = await fetch('/lurl/api/retry-status');
        const data = await res.json();
        const btn = document.getElementById('retryBtn');
        if (data.ok) {
          if (!data.puppeteerAvailable) {
            setStatus('retryStatus', 'Puppeteer 未安裝', 'error');
            btn.disabled = true;
          } else if (data.failed === 0) {
            setStatus('retryStatus', '無失敗記錄', 'success');
            btn.disabled = true;
          } else {
            setStatus('retryStatus', '待重試 ' + data.failed + ' 個');
          }
        }
      } catch (e) {
        setStatus('retryStatus', '載入失敗', 'error');
      }
    }

    async function retryFailed() {
      const btn = document.getElementById('retryBtn');
      btn.disabled = true;
      setStatus('retryStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/retry-failed', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '沒有需要重試的記錄');
            setStatus('retryStatus', '無需重試', 'success');
          } else {
            showToast('開始重試 ' + data.total + ' 個，請查看 console');
            setStatus('retryStatus', '處理中 ' + data.total + ' 個', 'processing');
          }
        } else {
          showToast('重試失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('retryStatus', '重試失敗', 'error');
          btn.disabled = false;
        }
      } catch (e) {
        showToast('重試失敗: ' + e.message, 'error');
        setStatus('retryStatus', '重試失敗', 'error');
        btn.disabled = false;
      }
    }

    async function generateThumbnails() {
      const btn = document.getElementById('thumbBtn');
      btn.disabled = true;
      setStatus('thumbStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/generate-thumbnails', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '所有影片都已有縮圖');
            setStatus('thumbStatus', '無需產生', 'success');
          } else {
            showToast('開始產生 ' + data.total + ' 個縮圖');
            setStatus('thumbStatus', '處理中 ' + data.total + ' 個', 'processing');
          }
        } else {
          showToast('產生失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('thumbStatus', '產生失敗', 'error');
          btn.disabled = false;
        }
      } catch (e) {
        showToast('產生失敗: ' + e.message, 'error');
        setStatus('thumbStatus', '產生失敗', 'error');
        btn.disabled = false;
      }
    }

    async function repairPaths() {
      const btn = document.getElementById('repairBtn');
      btn.disabled = true;
      setStatus('repairStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/repair-paths', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast(data.message);
          setStatus('repairStatus', data.fixed > 0 ? '已修復 ' + data.fixed + ' 個' : '無需修復', 'success');
          if (data.fixed > 0) {
            loadStats();
            loadRecords();
            loadRetryStatus();
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('repairStatus', '修復失敗', 'error');
        }
        btn.disabled = false;
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        setStatus('repairStatus', '修復失敗', 'error');
        btn.disabled = false;
      }
    }

    async function cleanupDuplicates() {
      const btn = document.getElementById('dupBtn');
      btn.disabled = true;
      setStatus('dupStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/cleanup-duplicates', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.removed === 0) {
            showToast(data.message || '沒有重複記錄');
            setStatus('dupStatus', '無重複', 'success');
          } else {
            showToast('已清理 ' + data.removed + ' 個重複記錄');
            setStatus('dupStatus', '已清理 ' + data.removed + ' 個', 'success');
            loadStats();
            loadRecords();
          }
        } else {
          showToast('清理失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('dupStatus', '清理失敗', 'error');
        }
        btn.disabled = false;
      } catch (e) {
        showToast('清理失敗: ' + e.message, 'error');
        setStatus('dupStatus', '清理失敗', 'error');
        btn.disabled = false;
      }
    }

    // ===== 滾動位置記憶 =====
    const SCROLL_KEY = 'lurlAdminScroll';

    function saveScrollPosition() {
      const currentTab = location.hash.replace('#', '') || 'records';
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
        tab: currentTab,
        scrollY: window.scrollY
      }));
    }

    function restoreScrollPosition() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
        const currentTab = location.hash.replace('#', '') || 'records';
        // 只有在同一個 tab 才恢復滾動位置
        if (saved.tab === currentTab && saved.scrollY) {
          setTimeout(() => window.scrollTo(0, saved.scrollY), 50);
        }
      } catch (e) {}
    }

    // 離開頁面時記錄
    window.addEventListener('beforeunload', saveScrollPosition);
    // 點擊連結時也記錄（以防 beforeunload 不觸發）
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link && !link.href.includes('#')) saveScrollPosition();
    });

    // 初始化
    loadStats();
    loadRecords();
    loadVersionConfig();
    loadRetryStatus();
    checkHashAndSwitch();
    restoreScrollPosition();
    listenHLSProgress();
  </script>
</body>
</html>`;
}

function browsePage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl 影片庫</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: white; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    /* Search Bar */
    .search-bar { margin-bottom: 20px; }
    .search-bar input {
      width: 100%;
      max-width: 500px;
      padding: 12px 16px;
      border: none;
      border-radius: 8px;
      background: #1a1a1a;
      color: white;
      font-size: 1em;
      outline: none;
    }
    .search-bar input::placeholder { color: #666; }
    .search-bar input:focus { box-shadow: 0 0 0 2px #3b82f6; }

    /* Filter Bar */
    .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .tabs { display: flex; gap: 10px; }
    .tab { padding: 8px 16px; background: #333; border: none; border-radius: 20px; color: white; cursor: pointer; transition: all 0.2s; }
    .tab:hover { background: #444; }
    .tab.active { background: #3b82f6; color: #fff; }
    .result-count { margin-left: auto; color: #888; font-size: 1.1em; font-weight: 500; }

    /* Pagination */
    .pagination { display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 30px; flex-wrap: wrap; }
    .pagination button { min-width: 40px; height: 40px; border: none; border-radius: 8px; background: #252525; color: #888; cursor: pointer; font-size: 14px; transition: all 0.2s; }
    .pagination button:hover:not(:disabled) { background: #333; color: #fff; }
    .pagination button.active { background: #3b82f6; color: #fff; }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination button.nav-btn { padding: 0 12px; }
    .pagination button .nav-text { display: inline; }
    .pagination button .nav-icon { display: none; }
    .pagination .page-info { color: #666; font-size: 14px; margin: 0 10px; }

    /* Grid */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .card { background: #1a1a1a; border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
    .card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px rgba(0,0,0,0.3); }

    /* Thumbnail - No video preload! */
    .card-thumb {
      aspect-ratio: 16/9;
      background: linear-gradient(135deg, #1e3a5f 0%, #0f1a2e 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
      position: relative;
      overflow: hidden;
    }
    .card-thumb .play-icon {
      width: 60px;
      height: 60px;
      background: rgba(255,255,255,0.15);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
      z-index: 2;
    }
    .card:hover .card-thumb .play-icon { background: rgba(59,130,246,0.8); transform: scale(1.1); }
    .card-thumb .play-icon::after {
      content: '';
      width: 0;
      height: 0;
      border-left: 18px solid white;
      border-top: 11px solid transparent;
      border-bottom: 11px solid transparent;
      margin-left: 4px;
    }
    .card-thumb.pending { background: linear-gradient(135deg, #3d2a1a 0%, #1a1a1a 100%); }
    .card-thumb.image { background: linear-gradient(135deg, #2d1a3d 0%, #1a1a2e 100%); }
    .card-thumb img {
      width: 100%; height: 100%; object-fit: cover;
      filter: blur(20px); opacity: 0;
      transition: filter 0.4s ease-out, opacity 0.4s ease-out;
      position: absolute; top: 0; left: 0;
    }
    .card-thumb img.loaded { filter: blur(4px); opacity: 1; }
    .card:hover .card-thumb img.loaded { filter: blur(2px); }

    /* Card Info */
    .card-info { padding: 12px; }
    .card-title { font-size: 0.95em; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 8px; }
    .card-meta { display: flex; justify-content: space-between; align-items: center; }
    .card-date { font-size: 0.8em; color: #666; }
    .card-id {
      font-size: 0.75em;
      color: #3b82f6;
      background: rgba(59,130,246,0.1);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .card-id:hover { background: rgba(59,130,246,0.3); }
    .card-status { font-size: 0.75em; color: #f59e0b; margin-top: 4px; }

    .empty { text-align: center; padding: 60px; color: #666; }

    /* Skeleton Loading */
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
    .skeleton-card { background: #1a1a1a; border-radius: 12px; overflow: hidden; }
    .skeleton-thumb { aspect-ratio: 16/9; }
    .skeleton-info { padding: 12px; }
    .skeleton-title { height: 20px; border-radius: 4px; margin-bottom: 12px; width: 80%; }
    .skeleton-meta { height: 14px; border-radius: 4px; width: 50%; }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; }

    /* Header Actions */
    .header-actions { display: flex; gap: 8px; margin-left: auto; margin-right: 20px; }
    .header-actions button {
      background: rgba(255,255,255,0.1);
      border: none;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 1.2em;
      cursor: pointer;
      transition: all 0.2s;
    }
    .header-actions button:hover { background: rgba(255,255,255,0.2); }
    .mute-btn.muted { background: #c62828; }

    /* Redeem Panel */
    .redeem-panel {
      display: none;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 20px;
      border-bottom: 1px solid #333;
    }
    .redeem-panel.show { display: block; }
    .redeem-content { max-width: 400px; margin: 0 auto; text-align: center; }
    .redeem-content h3 { color: #fff; margin-bottom: 8px; }
    .redeem-desc { color: #888; font-size: 0.9em; margin-bottom: 16px; }
    .redeem-input-group { display: flex; gap: 8px; }
    .redeem-input-group input {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid #333;
      border-radius: 8px;
      background: #0f0f0f;
      color: white;
      font-size: 1.1em;
      font-family: monospace;
      letter-spacing: 2px;
      text-transform: uppercase;
      text-align: center;
    }
    .redeem-input-group input:focus { border-color: #4ade80; outline: none; }
    .redeem-input-group button {
      padding: 12px 24px;
      background: #4ade80;
      color: #000;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }
    .redeem-input-group button:hover { background: #22c55e; }
    .redeem-status { margin-top: 12px; font-size: 0.9em; min-height: 20px; }
    .redeem-status.success { color: #4ade80; }
    .redeem-status.error { color: #f87171; }

    /* Card Actions (Rating & Block) */
    .card-actions { display: flex; gap: 6px; margin-top: 8px; }
    .card-actions button {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: #333;
      color: #aaa;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .card-actions button:hover { background: #444; color: white; }
    .card-actions .btn-like.active { background: #4caf50; color: white; }
    .card-actions .btn-dislike.active { background: #f44336; color: white; }
    .card-actions .btn-block:hover { background: #c62828; color: white; }
    .card.blocked { opacity: 0.5; }
    .card.blocked .card-thumb { filter: grayscale(1); }

    /* Card Tags */
    .card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .card-tags .tag {
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.75em;
      cursor: pointer;
      background: #2a2a2a;
      color: #888;
      border: 1px solid #333;
      transition: all 0.2s;
    }
    .card-tags .tag:hover { background: #333; color: #ccc; border-color: #444; }
    .card-tags .tag.active { background: #ec4899; color: white; border-color: #ec4899; }

    .tag-group { display: inline-flex; align-items: center; position: relative; }
    .tag-expand {
      font-size: 0.6em;
      cursor: pointer;
      padding: 2px 4px;
      color: #888;
      margin-left: -4px;
    }
    .tag-expand:hover { color: #ec4899; }
    .tag-popover {
      position: absolute;
      top: 100%;
      left: 0;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 8px;
      z-index: 100;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 120px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .tag-popover .tag.sub {
      font-size: 0.75em;
      padding: 4px 8px;
      background: #2a2a2a;
    }
    .tag-popover .tag.sub.active { background: #be185d; border-color: #be185d; }

    /* Tag filter bar */
    .tag-filter {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
      padding: 12px;
      background: #1a1a1a;
      border-radius: 8px;
    }
    .tag-filter .filter-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .tag-filter .filter-tag {
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 0.85em;
      cursor: pointer;
      background: #2a2a2a;
      color: #888;
      border: 1px solid #333;
      transition: all 0.2s;
    }
    .tag-filter .filter-tag:hover { background: #333; color: #ccc; }
    .tag-filter .filter-tag.active { background: #ec4899; color: white; border-color: #ec4899; }
    .tag-filter .filter-popover {
      position: absolute;
      top: 100%;
      left: 0;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 8px;
      z-index: 100;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 140px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .tag-filter .filter-sub {
      padding: 6px 12px;
      font-size: 0.8em;
      background: #2a2a2a;
      border: 1px solid #333;
      border-radius: 16px;
      cursor: pointer;
      color: #888;
    }
    .tag-filter .filter-sub:hover { background: #333; }
    .tag-filter .filter-sub.active { background: #be185d; border-color: #be185d; color: white; }
    .tag-filter .clear-filter {
      padding: 6px 12px;
      background: #333;
      color: #888;
      border: none;
      border-radius: 16px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .tag-filter .clear-filter:hover { background: #444; color: #fff; }

    /* ===== RWD 響應式設計 ===== */

    /* Tablet (768px - 1023px) */
    @media (max-width: 1023px) {
      .container { padding: 16px; }
      .grid { grid-template-columns: repeat(3, 1fr); gap: 16px; }
      .card-thumb .play-icon { width: 50px; height: 50px; }
      .card-thumb .play-icon::after { border-left-width: 14px; border-top-width: 9px; border-bottom-width: 9px; }
    }

    /* Mobile Landscape (480px - 767px) */
    @media (max-width: 767px) {
      .header { padding: 12px 16px; }
      .header .logo { height: 28px; }
      .header h1 { font-size: 1.1em; }
      .header nav { gap: 12px; }
      .header nav a { font-size: 0.85em; }

      .container { padding: 12px; }
      .search-bar input { padding: 10px 14px; font-size: 16px; max-width: 100%; }

      .filter-bar { flex-direction: column; align-items: stretch; gap: 12px; }
      .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
      .tabs::-webkit-scrollbar { display: none; }
      .tab { padding: 6px 12px; font-size: 0.9em; white-space: nowrap; flex-shrink: 0; }
      .result-count { margin-left: 0; text-align: center; }

      .grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
      .card { border-radius: 10px; }
      .card-info { padding: 10px; }
      .card-title { font-size: 0.85em; -webkit-line-clamp: 2; }
      .card-date { font-size: 0.75em; }
      .card-id { font-size: 0.7em; padding: 2px 6px; }
      .card-actions { flex-wrap: wrap; }
      .card-actions button { padding: 3px 6px; font-size: 0.8em; }

      .pagination { gap: 6px; margin-top: 24px; }
      .pagination button { min-width: 36px; height: 36px; font-size: 13px; }
      .pagination .page-info { font-size: 12px; margin: 0 6px; }

      .toast { bottom: 12px; right: 12px; left: 12px; text-align: center; }
    }

    /* Mobile Portrait (< 480px) */
    @media (max-width: 479px) {
      .header { padding: 10px 12px; }
      .header .logo { height: 24px; }
      .header h1 { font-size: 1em; }
      .header nav a { font-size: 0.8em; }

      .container { padding: 10px; }
      .search-bar { margin-bottom: 12px; }
      .filter-bar { margin-bottom: 12px; }

      .grid { gap: 10px; }
      .card { border-radius: 8px; }
      .card-thumb { font-size: 36px; }
      .card-thumb .play-icon { width: 44px; height: 44px; }
      .card-thumb .play-icon::after { border-left-width: 12px; border-top-width: 7px; border-bottom-width: 7px; margin-left: 3px; }
      .card-info { padding: 8px; }
      .card-title { font-size: 0.8em; margin-bottom: 6px; }
      .card-meta { flex-direction: column; align-items: flex-start; gap: 4px; }
      .card-actions button { min-height: 32px; }

      .pagination button .nav-text { display: none; }
      .pagination button .nav-icon { display: inline; }
      .pagination button.nav-btn { min-width: 36px; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
      <h1>影片庫</h1>
    </div>
    <div class="header-actions">
      <button id="muteToggle" class="mute-btn" onclick="toggleGlobalMute()" title="靜音模式">🔊</button>
      <button class="redeem-btn" onclick="toggleRedeemPanel()" title="兌換序號">🎁</button>
    </div>
    <nav>
      <a href="/lurl/admin">Admin</a>
      <a href="/lurl/browse" class="active">Browse</a>
    </nav>
  </div>
  <!-- 序號兌換面板 -->
  <div class="redeem-panel" id="redeemPanel">
    <div class="redeem-content">
      <h3>🎁 兌換額度</h3>
      <p class="redeem-desc">輸入序號獲得額外備份額度</p>
      <div class="redeem-input-group">
        <input type="text" id="redeemCode" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocomplete="off">
        <button onclick="submitRedeem()">兌換</button>
      </div>
      <div id="redeemStatus" class="redeem-status"></div>
    </div>
  </div>
  <div class="container">
    <div class="search-bar">
      <input type="text" id="search" placeholder="Search by title, ID, or URL (e.g. n41Xm, mkhev)..." autocomplete="off">
    </div>
    <div class="filter-bar">
      <div class="tabs">
        <button class="tab active" data-type="all">全部</button>
        <button class="tab" data-type="video">影片</button>
        <button class="tab" data-type="image">圖片</button>
        <button class="tab" data-type="pending" style="background:#f59e0b;color:#000;">未下載</button>
        <button class="tab" data-type="blocked" style="background:#666;">🚫 已封鎖</button>
      </div>
      <div class="result-count" id="resultCount"></div>
    </div>
    <div class="tag-filter" id="tagFilter"></div>
    <div class="grid" id="grid">
      <!-- 骨架屏 -->
      ${Array(8).fill(0).map(() => `
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="pagination" id="pagination"></div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let allRecords = [];
    let currentType = localStorage.getItem('lurl_browse_tab') || 'all';
    let searchQuery = '';
    let isLoading = false;
    let selectedFilterTags = [];  // 篩選用的標籤
    let expandedFilterTag = null; // 展開的篩選主標籤

    // ===== 訪客 ID =====
    function getVisitorId() {
      let id = localStorage.getItem('lurl_visitor_id');
      if (!id) {
        id = 'V_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('lurl_visitor_id', id);
      }
      return id;
    }

    // ===== 靜音模式 =====
    let globalMuted = localStorage.getItem('lurl_muted') === 'true';

    function initMuteState() {
      const btn = document.getElementById('muteToggle');
      if (globalMuted) {
        btn.textContent = '🔇';
        btn.classList.add('muted');
      }
    }

    function toggleGlobalMute() {
      globalMuted = !globalMuted;
      localStorage.setItem('lurl_muted', globalMuted);
      const btn = document.getElementById('muteToggle');
      btn.textContent = globalMuted ? '🔇' : '🔊';
      btn.classList.toggle('muted', globalMuted);
      showToast(globalMuted ? '已開啟靜音模式' : '已關閉靜音模式');
    }

    // ===== 序號兌換 =====
    function toggleRedeemPanel() {
      const panel = document.getElementById('redeemPanel');
      panel.classList.toggle('show');
      if (panel.classList.contains('show')) {
        document.getElementById('redeemCode').focus();
      }
    }

    // 自動格式化輸入的序號
    document.addEventListener('DOMContentLoaded', () => {
      const input = document.getElementById('redeemCode');
      if (input) {
        input.addEventListener('input', (e) => {
          let value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          if (value.length > 4) value = value.slice(0, 4) + '-' + value.slice(4);
          if (value.length > 9) value = value.slice(0, 9) + '-' + value.slice(9);
          e.target.value = value.slice(0, 14);
        });
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') submitRedeem();
        });
      }
      initMuteState();
    });

    async function submitRedeem() {
      const input = document.getElementById('redeemCode');
      const status = document.getElementById('redeemStatus');
      const code = input.value.trim();

      if (!code) {
        status.textContent = '請輸入兌換碼';
        status.className = 'redeem-status error';
        return;
      }

      status.textContent = '兌換中...';
      status.className = 'redeem-status';

      try {
        const res = await fetch('/lurl/api/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, visitorId: getVisitorId() })
        });
        const data = await res.json();

        if (data.ok) {
          status.textContent = '✅ 兌換成功！獲得 +' + data.bonus + ' 額度';
          status.className = 'redeem-status success';
          input.value = '';
          showToast('🎉 成功獲得 ' + data.bonus + ' 額度！');
        } else {
          status.textContent = '❌ ' + data.error;
          status.className = 'redeem-status error';
        }
      } catch (err) {
        status.textContent = '❌ 兌換失敗：' + err.message;
        status.className = 'redeem-status error';
      }
    }

    // 恢復上次的 tab 狀態
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.type === currentType);
    });

    function showSkeleton() {
      document.getElementById('grid').innerHTML = Array(8).fill(0).map(() => \`
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      \`).join('');
    }

    let currentPage = 1;
    let totalRecords = 0;
    let totalPages = 1;
    const perPage = 24;
    const TAG_TREE = {
      '奶子': ['穿衣', '裸體', '大奶', '露點'],
      '屁股': [],
      '鮑魚': [],
      '全身': [],
      '姿勢': ['女上', '傳教士', '背後'],
      '口交': []
    };
    const MAIN_TAGS = Object.keys(TAG_TREE);

    // 檢查記錄是否有某主分類的標籤（包含子標籤）
    function hasMainTag(tags, mainTag) {
      return tags.some(t => t === mainTag || t.startsWith(mainTag + ':'));
    }

    async function toggleTag(recordId, tag) {
      const record = allRecords.find(r => r.id === recordId);
      if (!record) return;

      const currentTags = record.tags || [];
      const newTags = currentTags.includes(tag)
        ? currentTags.filter(t => t !== tag)
        : [...currentTags, tag];

      try {
        const res = await fetch(\`/lurl/api/records/\${recordId}/tags\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: newTags })
        });
        const data = await res.json();
        if (data.ok) {
          record.tags = data.tags;
          renderGrid();
        }
      } catch (e) {
        showToast('標籤更新失敗');
      }
    }

    // 展開的標籤選擇器狀態
    let expandedTagSelector = null;

    function toggleTagPopover(recordId, mainTag, event) {
      event.stopPropagation();
      const key = recordId + ':' + mainTag;
      expandedTagSelector = (expandedTagSelector === key) ? null : key;
      renderGrid();
    }

    // 點擊外部關閉 popover
    document.addEventListener('click', (e) => {
      if (expandedTagSelector && !e.target.closest('.tag-group')) {
        expandedTagSelector = null;
        renderGrid();
      }
    });

    function renderTagSelector(record) {
      const tags = record.tags || [];
      return MAIN_TAGS.map(mainTag => {
        const isActive = hasMainTag(tags, mainTag);
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedTagSelector === record.id + ':' + mainTag;

        let html = \`<span class="tag-group" data-group="\${record.id}:\${mainTag}">\`;

        if (hasSubTags) {
          // 有子標籤：點擊彈出 popover
          html += \`<span class="tag \${isActive ? 'active' : ''}" onclick="toggleTagPopover('\${record.id}', '\${mainTag}', event)">\${mainTag} ▾</span>\`;

          if (isExpanded) {
            html += \`<div class="tag-popover" onclick="event.stopPropagation()">\`;
            html += subTags.map(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = tags.includes(fullTag);
              return \`<span class="tag sub \${isSubActive ? 'active' : ''}" onclick="toggleTag('\${record.id}', '\${fullTag}')">\${sub}</span>\`;
            }).join('');
            html += \`</div>\`;
          }
        } else {
          // 沒有子標籤：直接切換
          html += \`<span class="tag \${isActive ? 'active' : ''}" onclick="toggleTag('\${record.id}', '\${mainTag}')">\${mainTag}</span>\`;
        }

        html += \`</span>\`;
        return html;
      }).join('');
    }

    // === 標籤篩選功能 ===
    function renderTagFilter() {
      let html = '';

      MAIN_TAGS.forEach(mainTag => {
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedFilterTag === mainTag;
        const isMainActive = selectedFilterTags.includes(mainTag);
        const hasActiveSubTags = selectedFilterTags.some(t => t.startsWith(mainTag + ':'));

        html += \`<span class="filter-group" style="position:relative;">\`;

        if (hasSubTags) {
          html += \`<span class="filter-tag \${isMainActive || hasActiveSubTags ? 'active' : ''}" onclick="toggleFilterPopover('\${mainTag}')">\${mainTag} ▾</span>\`;

          if (isExpanded) {
            html += \`<div class="filter-popover" onclick="event.stopPropagation()">\`;
            html += \`<span class="filter-sub \${isMainActive ? 'active' : ''}" onclick="toggleFilterTag('\${mainTag}')">全部</span>\`;
            html += subTags.map(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = selectedFilterTags.includes(fullTag);
              return \`<span class="filter-sub \${isSubActive ? 'active' : ''}" onclick="toggleFilterTag('\${fullTag}')">\${sub}</span>\`;
            }).join('');
            html += \`</div>\`;
          }
        } else {
          html += \`<span class="filter-tag \${isMainActive ? 'active' : ''}" onclick="toggleFilterTag('\${mainTag}')">\${mainTag}</span>\`;
        }

        html += \`</span>\`;
      });

      if (selectedFilterTags.length > 0) {
        html += \`<button class="clear-filter" onclick="clearFilterTags()">✕ 清除</button>\`;
      }

      document.getElementById('tagFilter').innerHTML = html;
    }

    function toggleFilterPopover(mainTag) {
      expandedFilterTag = (expandedFilterTag === mainTag) ? null : mainTag;
      renderTagFilter();
    }

    // 點擊外部關閉篩選 popover
    document.addEventListener('click', (e) => {
      if (expandedFilterTag && !e.target.closest('.filter-group')) {
        expandedFilterTag = null;
        renderTagFilter();
      }
    });

    function toggleFilterTag(tag) {
      if (selectedFilterTags.includes(tag)) {
        selectedFilterTags = selectedFilterTags.filter(t => t !== tag);
        // 如果取消主標籤，也取消該主分類下的所有子標籤
        if (!tag.includes(':')) {
          selectedFilterTags = selectedFilterTags.filter(t => !t.startsWith(tag + ':'));
        }
      } else {
        selectedFilterTags.push(tag);
      }
      currentPage = 1;
      renderTagFilter();
      loadRecords();
    }

    function clearFilterTags() {
      selectedFilterTags = [];
      expandedFilterTag = null;
      currentPage = 1;
      renderTagFilter();
      loadRecords();
    }

    async function loadRecords() {
      if (isLoading) return;
      showSkeleton();
      isLoading = true;

      const params = new URLSearchParams({
        page: currentPage,
        limit: perPage,
        ...(currentType !== 'all' && { type: currentType }),
        ...(searchQuery && { q: searchQuery }),
        ...(selectedFilterTags.length > 0 && { tags: selectedFilterTags.join(',') })
      });

      const res = await fetch('/lurl/api/records?' + params);
      const data = await res.json();
      isLoading = false;

      allRecords = data.records;
      totalRecords = data.total;
      totalPages = Math.ceil(totalRecords / perPage) || 1;

      renderGrid();
      renderPagination();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function goToPage(page) {
      if (page < 1 || page > totalPages || page === currentPage) return;
      currentPage = page;
      // 更新 URL
      const url = new URL(window.location);
      url.searchParams.set('page', page);
      history.pushState({}, '', url);
      loadRecords();
    }

    function renderPagination() {
      if (totalPages <= 1) {
        document.getElementById('pagination').innerHTML = '';
        return;
      }

      let html = '';
      html += \`<button class="nav-btn" onclick="goToPage(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}><span class="nav-icon">‹</span><span class="nav-text">上一頁</span></button>\`;

      // 顯示頁碼邏輯
      const maxVisible = 5;
      let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
      let endPage = Math.min(totalPages, startPage + maxVisible - 1);
      if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
      }

      if (startPage > 1) {
        html += \`<button onclick="goToPage(1)">1</button>\`;
        if (startPage > 2) html += \`<span class="page-info">...</span>\`;
      }

      for (let i = startPage; i <= endPage; i++) {
        html += \`<button onclick="goToPage(\${i})" class="\${i === currentPage ? 'active' : ''}">\${i}</button>\`;
      }

      if (endPage < totalPages) {
        if (endPage < totalPages - 1) html += \`<span class="page-info">...</span>\`;
        html += \`<button onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
      }

      html += \`<button class="nav-btn" onclick="goToPage(\${currentPage + 1})" \${currentPage === totalPages ? 'disabled' : ''}><span class="nav-text">下一頁</span><span class="nav-icon">›</span></button>\`;
      html += \`<span class="page-info">\${currentPage} / \${totalPages}</span>\`;

      document.getElementById('pagination').innerHTML = html;
    }

    function renderGrid() {
      document.getElementById('resultCount').textContent = totalRecords + ' items';

      if (allRecords.length === 0) {
        document.getElementById('grid').innerHTML = '<div class="empty">' +
          (searchQuery ? 'No results for "' + searchQuery + '"' : 'No content yet') + '</div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;

      const html = allRecords.map(r => \`
        <div class="card \${r.blocked ? 'blocked' : ''}" onclick="window.location.href='/lurl/view/\${r.id}'">
          <div class="card-thumb \${r.type === 'image' ? 'image' : ''} \${!r.fileExists ? 'pending' : ''}">
            \${r.fileExists
              ? (r.type === 'image'
                ? \`<img src="/lurl/files/\${r.thumbnailPath || r.backupPath}" loading="lazy" alt="\${getTitle(r.title)}" onload="this.classList.add('loaded')" onerror="this.style.display='none'">\`
                : (r.thumbnailExists && r.thumbnailPath
                  ? \`<img src="/lurl/files/\${r.thumbnailPath}" loading="lazy" alt="\${getTitle(r.title)}" onload="this.classList.add('loaded')" onerror="this.parentElement.innerHTML='<div class=play-icon></div>'"><div class="play-icon" style="position:absolute;"></div>\`
                  : '<div class="play-icon"></div>'))
              : '<span style="font-size:24px;color:#666">Pending</span>'}
          </div>
          <div class="card-info">
            <div class="card-title">\${getTitle(r.title)}</div>
            <div class="card-meta">
              <span class="card-date">\${new Date(r.capturedAt).toLocaleDateString()}</span>
              <span class="card-id" onclick="event.stopPropagation();copyId('\${r.id}')" title="Click to copy">#\${r.id}</span>
            </div>
            \${!r.fileExists ? '<div class="card-status">Backup pending</div>' : ''}
            <div class="card-actions">
              <button class="btn-like \${r.myVote === 'like' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'like')" title="讚">👍 \${r.likeCount || 0}</button>
              <button class="btn-dislike \${r.myVote === 'dislike' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'dislike')" title="倒讚">👎 \${r.dislikeCount || 0}</button>
              <button class="btn-block" onclick="event.stopPropagation();block('\${r.id}', \${!r.blocked})" title="\${r.blocked ? '解除封鎖' : '封鎖'}">\${r.blocked ? '✅' : '🚫'}</button>
            </div>
            <div class="card-tags" onclick="event.stopPropagation()">
              \${renderTagSelector(r)}
            </div>
          </div>
        </div>
      \`).join('');

      document.getElementById('grid').innerHTML = html;
    }

    function copyId(id) {
      navigator.clipboard.writeText(id);
      showToast('Copied: ' + id);
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    async function vote(id, voteType) {
      const record = allRecords.find(r => r.id === id);
      if (!record) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/vote\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote: voteType })
        });
        const data = await res.json();
        if (data.ok) {
          // 更新本地記錄
          record.likeCount = data.likeCount;
          record.dislikeCount = data.dislikeCount;
          record.myVote = data.myVote;
          renderGrid();
          if (data.myVote === 'like') showToast('👍 已按讚');
          else if (data.myVote === 'dislike') showToast('👎 已倒讚');
          else showToast('已取消投票');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    async function block(id, doBlock) {
      const action = doBlock ? '封鎖此內容？檔案將被刪除。' : '解除封鎖？';
      if (!confirm(action)) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/block\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block: doBlock })
        });
        const data = await res.json();
        if (data.ok) {
          if (doBlock) {
            // 封鎖後從列表移除（除非在已封鎖 tab）
            if (currentType !== 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            } else {
              const record = allRecords.find(r => r.id === id);
              if (record) record.blocked = true;
            }
          } else {
            // 解除封鎖後從已封鎖列表移除
            if (currentType === 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            }
          }
          renderGrid();
          showToast(doBlock ? '🚫 已封鎖' : '✅ 已解除封鎖');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    // Tab click
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        localStorage.setItem('lurl_browse_tab', currentType);
        currentPage = 1; // 重置頁碼
        loadRecords();
      });
    });

    // Search input with debounce
    let searchTimeout;
    document.getElementById('search').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = e.target.value.trim();
        currentPage = 1; // 重置頁碼
        loadRecords();
      }, 300);
    });

    // URL params
    const urlParams = new URLSearchParams(window.location.search);
    const qParam = urlParams.get('q');
    const pageParam = urlParams.get('page');
    if (qParam) {
      document.getElementById('search').value = qParam;
      searchQuery = qParam;
    }
    if (pageParam) {
      currentPage = parseInt(pageParam) || 1;
    }

    // 瀏覽器上一頁/下一頁
    window.addEventListener('popstate', () => {
      const params = new URLSearchParams(window.location.search);
      currentPage = parseInt(params.get('page')) || 1;
      loadRecords();
    });

    renderTagFilter();
    loadRecords();
  </script>
</body>
</html>`;
}

function viewPage(record, fileExists) {
  const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? '未命名' : t;
  const title = getTitle(record.title);
  const isVideo = record.type === 'video';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
  <title>${title} - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
    .media-container { background: #000; border-radius: 12px; overflow: hidden; margin-bottom: 20px; }
    .media-container video { width: 100%; max-height: 70vh; object-fit: contain; display: block; aspect-ratio: 16/9; background: #000; }
    .media-container img { width: 100%; max-height: 70vh; object-fit: contain; display: block; }
    /* Plyr Dark Theme */
    .plyr { --plyr-color-main: #3b82f6; }
    .plyr--video { border-radius: 12px; }
    .plyr__controls { background: linear-gradient(transparent, rgba(0,0,0,0.8)); }
    .plyr__control:hover { background: #3b82f6; }
    .media-missing { color: #666; text-align: center; padding: 40px; }
    .media-missing p { margin-bottom: 15px; }
    .info { background: #1a1a1a; border-radius: 12px; padding: 20px; }
    .info h2 { font-size: 1.3em; margin-bottom: 15px; line-height: 1.4; }
    .info-row { display: flex; gap: 10px; margin-bottom: 10px; color: #aaa; font-size: 0.9em; }
    .info-row span { color: #666; }
    .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
    .btn { padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 0.95em; border: none; cursor: pointer; }
    .btn-primary { background: #2196F3; color: white; }
    .btn-secondary { background: #333; color: white; }
    .btn-warning { background: #f59e0b; color: white; }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #aaa; text-decoration: none; }
    .back-link:hover { color: white; }
    .status { margin-top: 10px; font-size: 0.9em; }
    .status.success { color: #4ade80; }
    .status.error { color: #f87171; }

    /* Tags */
    .tags-section { display: flex; align-items: center; gap: 10px; margin: 15px 0; flex-wrap: wrap; }
    .tags-label { color: #666; font-size: 0.9em; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag {
      padding: 6px 14px;
      border-radius: 16px;
      font-size: 0.85em;
      cursor: pointer;
      background: #2a2a2a;
      color: #888;
      border: 1px solid #333;
      transition: all 0.2s;
    }
    .tag:hover { background: #333; color: #ccc; border-color: #444; }
    .tag.active { background: #ec4899; color: white; border-color: #ec4899; }
    .tag-group { display: inline-flex; align-items: center; position: relative; }
    .tag-popover {
      position: absolute;
      top: 100%;
      left: 0;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 8px;
      z-index: 100;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 140px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .tag-popover .tag.sub {
      font-size: 0.8em;
      padding: 6px 12px;
      background: #2a2a2a;
    }
    .tag-popover .tag.sub.active { background: #be185d; border-color: #be185d; }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; }

    /* ===== RWD 響應式設計 ===== */
    @media (max-width: 767px) {
      .header { padding: 12px 16px; }
      .header .logo { height: 28px; }
      .header h1 { font-size: 1.1em; }
      .header nav { gap: 12px; }
      .header nav a { font-size: 0.85em; }

      .container { padding: 12px; }
      .media-container { border-radius: 8px; margin-bottom: 16px; }
      .media-container video, .media-container img { max-height: 50vh; }

      .back-link { margin-bottom: 12px; font-size: 0.9em; }
      .info { padding: 16px; border-radius: 10px; }
      .info h2 { font-size: 1.1em; margin-bottom: 12px; }
      .info-row { font-size: 0.85em; flex-wrap: wrap; }

      .actions { gap: 8px; }
      .btn { padding: 10px 16px; font-size: 0.9em; flex: 1; min-width: 120px; text-align: center; }
    }

    @media (max-width: 479px) {
      .header { padding: 10px 12px; }
      .header .logo { height: 24px; }
      .header nav a { font-size: 0.8em; }

      .container { padding: 10px; }
      .media-container { border-radius: 6px; }
      .media-container video, .media-container img { max-height: 40vh; }

      .info { padding: 12px; border-radius: 8px; }
      .info h2 { font-size: 1em; }
      .info-row { font-size: 0.8em; margin-bottom: 8px; }

      .actions { flex-direction: column; }
      .btn { width: 100%; min-height: 44px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
    </div>
    <nav>
      <a href="/lurl/admin">管理</a>
      <a href="/lurl/browse">瀏覽</a>
    </nav>
  </div>
  <div class="container">
    <a href="javascript:history.back()" class="back-link">← 返回影片庫</a>
    <div class="media-container">
      ${fileExists
        ? (isVideo
          ? `<video id="player" playsinline controls></video>`
          : `<img src="/lurl/files/${record.backupPath}" alt="${title}">`)
        : `<div class="media-missing">
            <p>⚠️ 檔案尚未下載成功</p>
            <p style="font-size:0.8em;color:#555;">原始位置：${record.fileUrl}</p>
          </div>`
      }
    </div>
    ${isVideo && fileExists ? `
    <div class="quality-info" style="text-align:center; margin-bottom:10px; font-size:0.85em; color:#666;">
      ${record.hlsReady ? '🎬 HLS 串流（可選畫質）' : '📹 原始檔案'}
    </div>
    ` : ''}
    <div class="info">
      <h2>${title}</h2>
      <div class="info-row"><span>類型：</span>${isVideo ? '影片' : '圖片'}</div>
      <div class="info-row"><span>來源：</span>${record.source || 'lurl'}</div>
      <div class="info-row"><span>收錄時間：</span>${new Date(record.capturedAt).toLocaleString('zh-TW')}</div>
      <div class="info-row"><span>本地檔案：</span>${fileExists ? '✅ 已備份' : '❌ 未備份'}</div>
      <div class="info-row" style="word-break:break-all;"><span>原始頁面：</span><a href="${record.pageUrl}" target="_blank" style="color:#4a9eff;font-size:0.85em;">${record.pageUrl}</a></div>
      <div class="info-row" style="word-break:break-all;"><span>CDN：</span><span style="color:#555;font-size:0.85em;">${record.fileUrl}</span></div>
      <div class="tags-section">
        <span class="tags-label">標籤：</span>
        <div class="tags" id="tags"></div>
      </div>
      <div class="actions">
        ${fileExists ? `<a href="/lurl/files/${record.backupPath}" download class="btn btn-primary">下載</a>` : ''}
        ${record.ref ? `<a href="${record.ref}" target="_blank" class="btn btn-secondary">📖 D卡文章</a>` : ''}
        ${!fileExists ? `<a href="${record.pageUrl}" target="_blank" class="btn btn-warning">🔄 重新下載（需安裝腳本）</a>` : ''}
      </div>
      ${!fileExists ? `<div class="status" style="margin-top:15px;color:#888;font-size:0.85em;">💡 點擊「重新下載」會開啟原始頁面，若已安裝 Tampermonkey 腳本，將自動備份檔案</div>` : ''}
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const recordId = '${record.id}';
    let currentTags = ${JSON.stringify(record.tags || [])};
    let expandedTag = null;

    const TAG_TREE = {
      '奶子': ['穿衣', '裸體', '大奶', '露點'],
      '屁股': [],
      '鮑魚': [],
      '全身': [],
      '姿勢': ['女上', '傳教士', '背後'],
      '口交': []
    };
    const MAIN_TAGS = Object.keys(TAG_TREE);

    function hasMainTag(tags, mainTag) {
      return tags.some(t => t === mainTag || t.startsWith(mainTag + ':'));
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function renderTags() {
      const container = document.getElementById('tags');
      let html = '';

      MAIN_TAGS.forEach(mainTag => {
        const isActive = hasMainTag(currentTags, mainTag);
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedTag === mainTag;

        html += '<span class="tag-group">';

        if (hasSubTags) {
          html += '<span class="tag ' + (isActive ? 'active' : '') + '" onclick="togglePopover(\\'' + mainTag + '\\')">' + mainTag + ' ▾</span>';

          if (isExpanded) {
            html += '<div class="tag-popover" onclick="event.stopPropagation()">';
            subTags.forEach(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = currentTags.includes(fullTag);
              html += '<span class="tag sub ' + (isSubActive ? 'active' : '') + '" onclick="toggleTag(\\'' + fullTag + '\\')">' + sub + '</span>';
            });
            html += '</div>';
          }
        } else {
          html += '<span class="tag ' + (isActive ? 'active' : '') + '" onclick="toggleTag(\\'' + mainTag + '\\')">' + mainTag + '</span>';
        }

        html += '</span>';
      });

      container.innerHTML = html;
    }

    function togglePopover(mainTag) {
      expandedTag = (expandedTag === mainTag) ? null : mainTag;
      renderTags();
    }

    document.addEventListener('click', (e) => {
      if (expandedTag && !e.target.closest('.tag-group')) {
        expandedTag = null;
        renderTags();
      }
    });

    async function toggleTag(tag) {
      const newTags = currentTags.includes(tag)
        ? currentTags.filter(t => t !== tag)
        : [...currentTags, tag];

      try {
        const res = await fetch('/lurl/api/records/' + recordId + '/tags', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: newTags })
        });
        const data = await res.json();
        if (data.ok) {
          currentTags = data.tags;
          renderTags();
        }
      } catch (e) {
        showToast('標籤更新失敗');
      }
    }

    renderTags();
  </script>
  ${isVideo && fileExists ? `
  <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script>
    const video = document.getElementById('player');
    const hlsReady = ${record.hlsReady || false};
    const hlsUrl = '/lurl/hls/${record.id}/master.m3u8';
    const mp4Url = '/lurl/files/${record.backupPath}';

    let hls = null;

    function initPlayer() {
      const plyrOptions = {
        controls: [
          'play-large', 'play', 'progress', 'current-time', 'mute',
          'volume', 'settings', 'pip', 'fullscreen'
        ],
        settings: ['quality', 'speed'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        keyboard: { focused: true, global: true },
        storage: { enabled: true, key: 'plyr' }
      };

      // HLS 模式：使用 hls.js
      if (hlsReady && Hls.isSupported()) {
        hls = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
          // 設定畫質選項
          const availableQualities = hls.levels.map(l => l.height);
          availableQualities.unshift(0); // 自動

          plyrOptions.quality = {
            default: 0,
            options: availableQualities,
            forced: true,
            onChange: (quality) => updateQuality(quality)
          };

          plyrOptions.i18n = {
            qualityLabel: { 0: '自動' }
          };

          const player = new Plyr(video, plyrOptions);
          setupPlayer(player);
        });

        hls.on(Hls.Events.ERROR, function(event, data) {
          if (data.fatal) {
            console.error('HLS 錯誤，切換到原始檔案', data);
            hls.destroy();
            video.src = mp4Url;
            const player = new Plyr(video, plyrOptions);
            setupPlayer(player);
          }
        });
      }
      // Safari 原生 HLS 支援
      else if (hlsReady && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        const player = new Plyr(video, plyrOptions);
        setupPlayer(player);
      }
      // 原始 MP4
      else {
        video.src = mp4Url;
        const player = new Plyr(video, plyrOptions);
        setupPlayer(player);
      }
    }

    function updateQuality(newQuality) {
      if (!hls) return;
      if (newQuality === 0) {
        hls.currentLevel = -1; // 自動
      } else {
        hls.levels.forEach((level, index) => {
          if (level.height === newQuality) {
            hls.currentLevel = index;
          }
        });
      }
    }

    function setupPlayer(player) {
      // 檢查靜音模式
      const globalMuted = localStorage.getItem('lurl_muted') === 'true';
      if (globalMuted) {
        player.muted = true;
      }

      // 自動播放
      player.on('ready', () => {
        player.play().catch(() => {});
      });
    }

    initPlayer();
  </script>
  ` : ''}
</body>
</html>`;
}

// ==================== 主處理器 ====================

module.exports = {
  match(req) {
    return req.url.startsWith('/lurl');
  },

  async handle(req, res) {
    const fullPath = req.url.split('?')[0];
    const urlPath = fullPath.replace(/^\/lurl/, '') || '/';
    const query = parseQuery(req.url);

    console.log(`[lurl] ${req.method} ${urlPath}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // ==================== 登入系統 ====================

    // GET /login - 登入頁面
    if (req.method === 'GET' && urlPath === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }

    // POST /login - 處理登入
    if (req.method === 'POST' && urlPath === '/login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const password = params.get('password');
        const redirect = params.get('redirect') || '/lurl/browse';

        if (password === ADMIN_PASSWORD) {
          const sessionToken = generateSessionToken(password);
          res.writeHead(302, {
            'Set-Cookie': `lurl_session=${sessionToken}; Path=/lurl; HttpOnly; SameSite=Strict; Max-Age=86400`,
            'Location': redirect
          });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginPage('密碼錯誤'));
        }
      });
      return;
    }

    // GET /logout - 登出
    if (req.method === 'GET' && urlPath === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': 'lurl_session=; Path=/lurl; HttpOnly; Max-Age=0',
        'Location': '/lurl/login'
      });
      res.end();
      return;
    }

    // ==================== Phase 1 ====================

    // GET /health
    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', version: 'v3-fixed', timestamp: new Date().toISOString() }));
      return;
    }

    // POST /capture (需要 CLIENT_TOKEN)
    if (req.method === 'POST' && urlPath === '/capture') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
      try {
        const { title, pageUrl, fileUrl, type = 'video', ref, cookies, thumbnail } = await parseBody(req);

        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 去重與封鎖檢查
        const existingRecords = readAllRecords();

        // 檢查 fileUrl 是否已被封鎖
        const blockedRecord = existingRecords.find(r => r.fileUrl === fileUrl && r.blocked);
        if (blockedRecord) {
          console.log(`[lurl] 跳過已封鎖內容: ${fileUrl}`);
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, blocked: true, message: '此內容已被封鎖' }));
          return;
        }
        const duplicate = existingRecords.find(r => r.pageUrl === pageUrl || r.fileUrl === fileUrl);
        if (duplicate) {
          // 檢查檔案是否真的存在
          const filePath = path.join(DATA_DIR, duplicate.backupPath);
          const fileExists = fs.existsSync(filePath);

          if (fileExists) {
            console.log(`[lurl] 跳過重複頁面: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, existingId: duplicate.id }));
          } else {
            // 記錄存在但檔案不存在，更新 fileUrl（CDN 可能換了）並讓前端上傳
            if (duplicate.fileUrl !== fileUrl) {
              console.log(`[lurl] CDN URL 已更新: ${duplicate.fileUrl} → ${fileUrl}`);
              // 更新記錄中的 fileUrl
              updateRecordFileUrl(duplicate.id, fileUrl);
            }
            console.log(`[lurl] 重複頁面但檔案遺失，需要前端上傳: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, id: duplicate.id, needUpload: true }));
          }
          return;
        }

        ensureDirs();
        // 先產生 ID，用於確保檔名唯一
        const id = Date.now().toString(36);

        // 從 fileUrl 取得原始副檔名
        const urlExt = path.extname(new URL(fileUrl).pathname).toLowerCase() || (type === 'video' ? '.mp4' : '.jpg');
        const ext = ['.mp4', '.mov', '.webm', '.avi'].includes(urlExt) ? urlExt : (type === 'video' ? '.mp4' : '.jpg');
        const safeTitle = sanitizeFilename(title);
        // 檔名加上 ID 確保唯一性（同標題不同影片不會覆蓋）
        const filename = `${safeTitle}_${id}${ext}`;
        const targetDir = type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const folder = type === 'video' ? 'videos' : 'images';
        const backupPath = `${folder}/${filename}`; // 用正斜線，URL 才正確

        // 保存縮圖（如果有）- 轉成 WebP 格式
        let thumbnailPath = null;
        if (thumbnail && type === 'video') {
          try {
            const thumbFilename = `${id}.webp`;
            const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
            // thumbnail 是 data:image/jpeg;base64,... 格式
            const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            // 用 sharp 轉成 WebP 並壓縮
            await sharp(buffer)
              .resize(320, null, { withoutEnlargement: true })
              .webp({ quality: 75 })
              .toFile(thumbFullPath);
            thumbnailPath = `thumbnails/${thumbFilename}`;
            console.log(`[lurl] 縮圖已存 (WebP): ${thumbFilename}`);
          } catch (thumbErr) {
            console.error(`[lurl] 縮圖保存失敗: ${thumbErr.message}`);
          }
        }

        const record = {
          id,
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath,
          ...(ref && { ref }), // D卡文章連結（如果有）
          ...(thumbnailPath && { thumbnailPath }) // 縮圖路徑（如果有）
        };

        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 後端用 cookies 嘗試下載（可能會失敗，但前端會補上傳）
        const videoFullPath = path.join(targetDir, filename);
        downloadFile(fileUrl, videoFullPath, pageUrl, cookies || '').then(async (ok) => {
          console.log(`[lurl] 後端備份${ok ? '完成' : '失敗'}: ${filename}${cookies ? ' (有cookie)' : ''}`);

          // 下載成功後處理縮圖
          if (ok) {
            if (type === 'video' && !thumbnailPath) {
              // 影片：用 ffmpeg 產生縮圖
              const thumbFilename = `${id}.webp`;
              const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
              const thumbOk = await generateVideoThumbnail(videoFullPath, thumbFullPath);
              if (thumbOk) {
                updateRecordThumbnail(id, `thumbnails/${thumbFilename}`);
              }
            }

            // 影片下載成功後自動加入 HLS 轉檔佇列
            if (type === 'video') {
              queueHLSTranscode(id);
            }

            if (type === 'image') {
              // 圖片：用 sharp 產生縮圖
              const thumbPath = await processImage(videoFullPath, id);
              if (thumbPath) {
                updateRecordThumbnail(id, thumbPath);
              }
            }
          }
        });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, id: record.id, needUpload: true }));
      } catch (err) {
        console.error('[lurl] Error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== RPC 單一入口 ====================
    // POST /api/rpc - 統一 API 入口（給 userscript 使用）
    // Action 縮寫對照：
    //   cb = check-backup   檢查備份
    //   rc = recover        執行修復
    //   vr = version        版本檢查
    //   bl = blocked-urls   封鎖清單
    //   rd = report-device  回報設備資訊
    if (req.method === 'POST' && urlPath === '/api/rpc') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const { a, p } = body; // a = action, p = payload
        const visitorId = req.headers['x-visitor-id'] || '';

        switch (a) {
          // cb = check-backup（邏輯同 /api/check-backup）
          case 'cb': {
            const pageUrl = p?.url;
            if (!pageUrl) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing url' }));
              return;
            }

            const urlId = extractUrlId(pageUrl);
            const records = readAllRecords();

            // 用 pageUrl 動態提取 ID 比對（相容舊資料）
            const record = records.find(r => {
              if (r.blocked) return false;
              const recordId = extractUrlId(r.pageUrl);
              return recordId === urlId;
            });

            if (!record) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ hasBackup: false }));
              return;
            }

            // 檢查本地檔案是否存在
            const localFilePath = path.join(DATA_DIR, record.backupPath);
            if (!fs.existsSync(localFilePath)) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ hasBackup: false }));
              return;
            }

            // 檢查是否已修復過
            const alreadyRecovered = visitorId ? !!hasRecovered(visitorId, urlId) : false;
            const quota = visitorId ? getVisitorQuota(visitorId) : { usedCount: 0, freeQuota: FREE_QUOTA };
            const remaining = getRemainingQuota(quota);
            const backupUrl = `/lurl/files/${record.backupPath}`;

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              hasBackup: true,
              alreadyRecovered,
              backupUrl,
              record: { type: record.type, title: record.title },
              quota: { remaining, used: quota.usedCount, total: quota.freeQuota + (quota.bonusQuota || 0) }
            }));
            return;
          }

          // rc = recover（邏輯同 /api/recover）
          case 'rc': {
            const pageUrl = p?.url;
            if (!pageUrl || !visitorId) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing url or visitorId' }));
              return;
            }

            const urlId = extractUrlId(pageUrl);
            const records = readAllRecords();

            // 用 pageUrl 動態提取 ID 比對
            const record = records.find(r => {
              if (r.blocked) return false;
              const recordId = extractUrlId(r.pageUrl);
              return recordId === urlId;
            });

            if (!record) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'no_backup' }));
              return;
            }

            // 檢查本地檔案是否存在
            const localFilePath = path.join(DATA_DIR, record.backupPath);
            if (!fs.existsSync(localFilePath)) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'no_backup' }));
              return;
            }

            const backupUrl = `/lurl/files/${record.backupPath}`;

            // 冪等性檢查
            const recoveredEntry = hasRecovered(visitorId, urlId);
            if (recoveredEntry) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({
                ok: true,
                alreadyRecovered: true,
                backupUrl,
                record: { type: record.type, title: record.title },
                quota: { remaining: getRemainingQuota(getVisitorQuota(visitorId)) }
              }));
              return;
            }

            // 檢查額度
            const quota = getVisitorQuota(visitorId);
            const remaining = getRemainingQuota(quota);

            if (remaining === 0) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'quota_exhausted' }));
              return;
            }

            // 扣額度
            const newQuota = useQuota(visitorId, pageUrl, urlId, backupUrl);
            const newRemaining = getRemainingQuota(newQuota);

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              ok: true,
              backupUrl,
              record: { type: record.type, title: record.title },
              quota: { remaining: newRemaining }
            }));
            return;
          }

          // vr = version
          case 'vr': {
            const config = readVersionConfig();
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              latestVersion: config.latestVersion,
              minVersion: config.minVersion,
              downloadUrl: config.downloadUrl,
              changelog: config.changelog
            }));
            return;
          }

          // bl = blocked-urls
          case 'bl': {
            if (!isClientAuthenticated(req)) {
              res.writeHead(401, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
              return;
            }

            const records = readAllRecords();
            const blockedUrls = records
              .filter(r => r.backupStatus === 'completed')
              .map(r => r.urlId);

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, blockedUrls }));
            return;
          }

          // rd = report-device
          case 'rd': {
            if (!visitorId) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing visitorId' }));
              return;
            }

            // 取得現有設備資訊
            const existingQuota = getVisitorQuota(visitorId) || {};
            const existingDevice = existingQuota.device || {};

            const device = {
              ...existingDevice,
              lastSeen: Date.now(),
            };

            // 基本設備資訊
            if (p?.nt || p?.dl || p?.rtt) {
              device.network = {
                type: p?.nt || existingDevice.network?.type || null,
                downlink: p?.dl || existingDevice.network?.downlink || null,
                rtt: p?.rtt || existingDevice.network?.rtt || null
              };
            }
            if (p?.cpu || p?.mem) {
              device.hardware = {
                cores: p?.cpu || existingDevice.hardware?.cores || null,
                memory: p?.mem || existingDevice.hardware?.memory || null
              };
            }
            if (p?.bl !== undefined || p?.bc !== undefined) {
              device.battery = {
                level: p?.bl ?? existingDevice.battery?.level ?? null,
                charging: p?.bc ?? existingDevice.battery?.charging ?? null
              };
            }

            // 測速結果
            if (p?.speedMbps) {
              device.speedTest = {
                mbps: p.speedMbps,
                bytes: p.speedBytes || null,
                duration: p.speedDuration || null,
                testedAt: Date.now()
              };
              console.log(`[lurl] 測速結果: ${visitorId.substring(0, 8)}... = ${p.speedMbps} Mbps`);
            }

            updateQuota(visitorId, { device });
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          default:
            res.writeHead(400, corsHeaders());
            res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
            return;
        }
      } catch (err) {
        console.error('[lurl] RPC error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/upload - 前端上傳 blob（支援分塊上傳，需要 CLIENT_TOKEN）
    if (req.method === 'POST' && urlPath === '/api/upload') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
      try {
        const id = req.headers['x-record-id'];
        const chunkIndex = req.headers['x-chunk-index'];
        const totalChunks = req.headers['x-total-chunks'];

        if (!id) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 x-record-id header' }));
          return;
        }

        // 找到對應的記錄
        const records = readAllRecords();
        const record = records.find(r => r.id === id);
        if (!record) {
          res.writeHead(404, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '找不到記錄' }));
          return;
        }

        // 讀取 body（binary）
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '沒有收到檔案資料' }));
          return;
        }

        ensureDirs();
        const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const filename = path.basename(record.backupPath);
        const destPath = path.join(targetDir, filename);

        // 分塊上傳
        if (chunkIndex !== undefined && totalChunks !== undefined) {
          const chunkDir = path.join(DATA_DIR, 'chunks', id);
          if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
          }

          // 存分塊
          const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
          fs.writeFileSync(chunkPath, buffer);
          console.log(`[lurl] 分塊 ${parseInt(chunkIndex) + 1}/${totalChunks} 收到: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

          // 檢查是否所有分塊都收到
          const receivedChunks = fs.readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).length;
          if (receivedChunks === parseInt(totalChunks)) {
            // 組裝完整檔案
            console.log(`[lurl] 所有分塊收齊，組裝中...`);

            // 同步寫入組裝檔案
            const allChunks = [];
            for (let i = 0; i < parseInt(totalChunks); i++) {
              const chunkData = fs.readFileSync(path.join(chunkDir, `chunk_${i}`));
              allChunks.push(chunkData);
            }
            const finalBuffer = Buffer.concat(allChunks);
            fs.writeFileSync(destPath, finalBuffer);

            // 清理分塊
            fs.rmSync(chunkDir, { recursive: true });

            console.log(`[lurl] 分塊上傳完成: ${filename} (${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

            // 上傳完成後為圖片生成縮圖
            if (record.type === 'image' && !record.thumbnailPath) {
              processImage(destPath, id).then(thumbPath => {
                if (thumbPath) updateRecordThumbnail(id, thumbPath);
              });
            }

            // 影片上傳完成後自動加入 HLS 轉檔佇列
            if (record.type === 'video') {
              queueHLSTranscode(id);
            }
          }

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, chunk: parseInt(chunkIndex), total: parseInt(totalChunks) }));
        } else {
          // 單次上傳（小檔案）
          fs.writeFileSync(destPath, buffer);
          console.log(`[lurl] 前端上傳成功: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

          // 上傳完成後為圖片生成縮圖
          if (record.type === 'image' && !record.thumbnailPath) {
            processImage(destPath, id).then(thumbPath => {
              if (thumbPath) updateRecordThumbnail(id, thumbPath);
            });
          }

          // 影片上傳完成後自動加入 HLS 轉檔佇列
          if (record.type === 'video') {
            queueHLSTranscode(id);
          }

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, size: buffer.length }));
        }
      } catch (err) {
        console.error('[lurl] Upload error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== Phase 2 ====================

    // GET /admin (需要登入)
    if (req.method === 'GET' && urlPath === '/admin') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/admin' });
        res.end();
        return;
      }
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(adminPage());
      return;
    }

    // GET /api/records (需要登入)
    if (req.method === 'GET' && urlPath === '/api/records') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      let records = readAllRecords().reverse(); // 最新的在前
      const type = query.type;
      const q = query.q;
      const page = parseInt(query.page) || 1;
      const limit = parseInt(query.limit) || 50; // 預設每頁 50 筆

      // 先檢查檔案存在狀態
      records = records.map(r => ({
        ...r,
        fileExists: fs.existsSync(path.join(DATA_DIR, r.backupPath))
      }));

      // Blocked filter (預設不顯示封鎖的，除非明確指定)
      const blocked = query.blocked;
      if (blocked === 'true') {
        records = records.filter(r => r.blocked);
      } else if (blocked !== 'all') {
        // 預設：不顯示封鎖的
        records = records.filter(r => !r.blocked);
      }

      // Rating filter
      const rating = query.rating;
      if (rating === 'like') {
        records = records.filter(r => r.rating === 'like');
      } else if (rating === 'dislike') {
        records = records.filter(r => r.rating === 'dislike');
      }

      // Type filter
      if (type === 'pending') {
        // 未下載：只顯示檔案不存在的
        records = records.filter(r => !r.fileExists);
      } else if (type === 'blocked') {
        // 已封鎖的：只顯示 blocked=true (已被上面的 blocked filter 過濾，這裡要重新讀取)
        records = readAllRecords().reverse()
          .map(r => ({ ...r, fileExists: fs.existsSync(path.join(DATA_DIR, r.backupPath)) }))
          .filter(r => r.blocked);
      } else {
        // 全部/影片/圖片：只顯示已下載的
        records = records.filter(r => r.fileExists);
        if (type && type !== 'all') {
          records = records.filter(r => r.type === type);
        }
      }

      // Search filter (q parameter)
      if (q) {
        const searchTerm = q.toLowerCase();
        records = records.filter(r =>
          r.id.toLowerCase().includes(searchTerm) ||
          (r.title && r.title.toLowerCase().includes(searchTerm)) ||
          (r.pageUrl && r.pageUrl.toLowerCase().includes(searchTerm))
        );
      }

      // Tag filter (AND logic - must match all selected tags)
      const tagsParam = query.tags;
      if (tagsParam) {
        const filterTags = tagsParam.split(',').filter(Boolean);
        records = records.filter(r => {
          const recordTags = r.tags || [];
          // 每個篩選標籤都必須匹配
          return filterTags.every(filterTag => {
            if (filterTag.includes(':')) {
              // 子標籤：精確匹配
              return recordTags.includes(filterTag);
            } else {
              // 主標籤：匹配主標籤本身或其任何子標籤
              return recordTags.some(t => t === filterTag || t.startsWith(filterTag + ':'));
            }
          });
        });
      }

      const total = records.length;
      const totalPages = Math.ceil(total / limit);

      // 分頁
      const start = (page - 1) * limit;
      const paginatedRecords = records.slice(start, start + limit);

      // 只對當前頁加上縮圖狀態
      const recordsWithStatus = paginatedRecords.map(r => ({
        ...r,
        thumbnailExists: r.thumbnailPath ? fs.existsSync(path.join(DATA_DIR, r.thumbnailPath)) : false
      }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        records: recordsWithStatus,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages
      }));
      return;
    }

    // GET /api/version - 腳本版本檢查（公開，不需要驗證）
    if (req.method === 'GET' && urlPath === '/api/version') {
      try {
        const versionFile = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionFile)) {
          const versionConfig = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify(versionConfig));
        } else {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            latestVersion: '0.0.0',
            minVersion: '0.0.0',
            message: '',
            updateUrl: '',
            forceUpdate: false,
            announcement: ''
          }));
        }
      } catch (err) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          latestVersion: '0.0.0',
          minVersion: '0.0.0',
          message: '',
          updateUrl: '',
          forceUpdate: false,
          announcement: ''
        }));
      }
      return;
    }

    // POST /api/version - 更新版本設定（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/version') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const body = await parseBody(req);
        const versionFile = path.join(__dirname, 'version.json');
        const config = {
          latestVersion: body.latestVersion || '0.0.0',
          minVersion: body.minVersion || '0.0.0',
          message: body.message || '',
          updateUrl: body.updateUrl || '',
          forceUpdate: body.forceUpdate || false,
          announcement: body.announcement || ''
        };
        fs.writeFileSync(versionFile, JSON.stringify(config, null, 2));
        console.log('[lurl] 版本設定已更新:', config.latestVersion);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[lurl] 更新版本設定失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/fix-untitled - 修復 untitled 記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/fix-untitled') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const records = readAllRecords();
        const untitledRecords = records.filter(r => r.title === 'untitled');

        if (untitledRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有需要修復的 untitled 記錄' }));
          return;
        }

        // 讀取所有行
        const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
        const newLines = lines.map(line => {
          try {
            const record = JSON.parse(line);
            if (record.title === 'untitled') {
              // 使用 ID 作為唯一標識
              record.title = `untitled_${record.id}`;
            }
            return JSON.stringify(record);
          } catch (e) {
            return line;
          }
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
        console.log(`[lurl] 已修復 ${untitledRecords.length} 個 untitled 記錄`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, fixed: untitledRecords.length }));
      } catch (err) {
        console.error('[lurl] 修復 untitled 失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/cleanup-duplicates - 清理重複記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/cleanup-duplicates') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        const seen = new Map(); // fileUrl -> record (保留第一個)
        const toRemove = [];

        records.forEach(r => {
          // 優先用 fileUrl 去重，若 fileUrl 相同只保留第一筆
          if (seen.has(r.fileUrl)) {
            toRemove.push(r);
          } else {
            seen.set(r.fileUrl, r);
          }
        });

        if (toRemove.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, removed: 0, message: '沒有重複記錄' }));
          return;
        }

        // 刪除重複記錄的檔案（如果有）
        toRemove.forEach(r => {
          const filePath = path.join(DATA_DIR, r.backupPath);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[lurl] 刪除重複檔案: ${r.backupPath}`);
          }
          if (r.thumbnailPath) {
            const thumbPath = path.join(DATA_DIR, r.thumbnailPath);
            if (fs.existsSync(thumbPath)) {
              fs.unlinkSync(thumbPath);
            }
          }
        });

        // 保留的記錄
        const keepRecords = Array.from(seen.values());
        fs.writeFileSync(RECORDS_FILE, keepRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已清理 ${toRemove.length} 個重複記錄`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, removed: toRemove.length }));
      } catch (err) {
        console.error('[lurl] 清理重複失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/repair-paths - 修復重複的 backupPath（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/repair-paths') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();

        // 找出 backupPath 重複的
        const pathCounts = {};
        records.forEach(r => {
          pathCounts[r.backupPath] = (pathCounts[r.backupPath] || 0) + 1;
        });

        const duplicatePaths = new Set(
          Object.entries(pathCounts).filter(([_, count]) => count > 1).map(([p]) => p)
        );

        if (duplicatePaths.size === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有重複的檔案路徑' }));
          return;
        }

        let fixedCount = 0;
        const updatedRecords = records.map(r => {
          if (duplicatePaths.has(r.backupPath)) {
            // 產生新的唯一檔名
            const ext = path.extname(r.backupPath);
            const folder = r.type === 'video' ? 'videos' : 'images';
            const safeTitle = sanitizeFilename(r.title.replace(/_[a-z0-9]+$/i, '')); // 移除舊的 ID 後綴
            const newFilename = `${safeTitle}_${r.id}${ext}`;
            const newBackupPath = `${folder}/${newFilename}`;

            console.log(`[lurl] 修復路徑: ${r.backupPath} → ${newBackupPath}`);

            fixedCount++;
            return {
              ...r,
              backupPath: newBackupPath,
              fileExists: false, // 標記需要重新下載
            };
          }
          return r;
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, updatedRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已修復 ${fixedCount} 個重複路徑`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          fixed: fixedCount,
          message: `已修復 ${fixedCount} 個路徑，請執行「重試失敗下載」重新抓取`
        }));
      } catch (err) {
        console.error('[lurl] 修復路徑失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/generate-thumbnails - 為現有影片產生縮圖（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/generate-thumbnails') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出有影片檔案但沒縮圖的記錄
        const needThumbnails = records.filter(r => {
          if (r.type !== 'video') return false;
          if (r.thumbnailPath && fs.existsSync(path.join(DATA_DIR, r.thumbnailPath))) return false;
          const videoPath = path.join(DATA_DIR, r.backupPath);
          return fs.existsSync(videoPath);
        });

        if (needThumbnails.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '所有影片都已有縮圖' }));
          return;
        }

        console.log(`[lurl] 開始產生 ${needThumbnails.length} 個縮圖`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: needThumbnails.length,
          message: `開始產生 ${needThumbnails.length} 個縮圖...`
        }));

        // 背景執行
        (async () => {
          let successCount = 0;
          for (let i = 0; i < needThumbnails.length; i++) {
            const record = needThumbnails[i];
            console.log(`[lurl] 產生縮圖 ${i + 1}/${needThumbnails.length}: ${record.id}`);

            const videoPath = path.join(DATA_DIR, record.backupPath);
            const thumbFilename = `${record.id}.jpg`;
            const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

            const ok = await generateVideoThumbnail(videoPath, thumbPath);
            if (ok) {
              updateRecordThumbnail(record.id, `thumbnails/${thumbFilename}`);
              successCount++;
            }

            // 間隔避免太快
            if (i < needThumbnails.length - 1) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          console.log(`[lurl] 縮圖產生完成: ${successCount}/${needThumbnails.length}`);
        })().catch(err => {
          console.error('[lurl] 縮圖產生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 縮圖產生失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/retry-failed - 重試下載失敗的檔案（需要 Admin 登入）
    // 使用 Puppeteer 開原頁面，在頁面 context 裡下載 CDN
    if (req.method === 'POST' && urlPath === '/api/retry-failed') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      if (!lurlRetry) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Puppeteer 未安裝，請執行 npm install' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出下載失敗的記錄 (fileExists === false 或檔案不存在)
        const failedRecords = records.filter(r => {
          if (r.fileExists === false) return true;
          const filePath = path.join(DATA_DIR, r.backupPath);
          return !fs.existsSync(filePath);
        });

        if (failedRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '沒有需要重試的失敗記錄' }));
          return;
        }

        console.log(`[lurl] 開始用 Puppeteer 重試 ${failedRecords.length} 個失敗記錄`);

        // 非同步處理，先回傳
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: failedRecords.length,
          message: `開始重試 ${failedRecords.length} 個失敗記錄，處理中...`
        }));

        // 背景執行重試 - 用 Puppeteer 在頁面 context 下載
        (async () => {
          const result = await lurlRetry.batchRetry(failedRecords, DATA_DIR, (current, total, record) => {
            console.log(`[lurl] 重試進度: ${current}/${total} - ${record.id}`);
          });

          // 更新記錄的 fileExists 狀態
          if (result.successCount > 0) {
            const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
            const newLines = lines.map(line => {
              try {
                const rec = JSON.parse(line);
                if (result.successIds.includes(rec.id)) {
                  rec.fileExists = true;
                  rec.retrySuccess = true;
                  rec.retriedAt = new Date().toISOString();
                }
                return JSON.stringify(rec);
              } catch (e) {
                return line;
              }
            });
            fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
          }

          console.log(`[lurl] 重試完成: 成功 ${result.successCount}/${result.total}`);
        })().catch(err => {
          console.error('[lurl] 重試過程發生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 重試失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/retry-status - 取得失敗記錄數量
    if (req.method === 'GET' && urlPath === '/api/retry-status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const records = readAllRecords();
      const failedRecords = records.filter(r => {
        if (r.fileExists === false) return true;
        const filePath = path.join(DATA_DIR, r.backupPath);
        return !fs.existsSync(filePath);
      });
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        failed: failedRecords.length,
        puppeteerAvailable: !!lurlRetry
      }));
      return;
    }

    // POST /api/optimize - 批次優化圖片（生成縮圖、轉 WebP）
    if (req.method === 'POST' && urlPath === '/api/optimize') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const { mode = 'thumbnails' } = body; // thumbnails | webp | both

        const records = readAllRecords();
        const results = { processed: 0, skipped: 0, failed: 0, details: [] };

        for (const record of records) {
          // 跳過沒有備份檔案的記錄
          const sourcePath = path.join(DATA_DIR, record.backupPath);
          if (!fs.existsSync(sourcePath)) {
            results.skipped++;
            continue;
          }

          // 生成缺少的縮圖
          if ((mode === 'thumbnails' || mode === 'both') && !record.thumbnailPath) {
            try {
              if (record.type === 'image') {
                const thumbPath = await processImage(sourcePath, record.id);
                if (thumbPath) {
                  updateRecordThumbnail(record.id, thumbPath);
                  results.processed++;
                  results.details.push({ id: record.id, action: 'thumbnail', status: 'ok' });
                } else {
                  results.failed++;
                }
              } else if (record.type === 'video') {
                const thumbFilename = `${record.id}.webp`;
                const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
                const ok = await generateVideoThumbnail(sourcePath, thumbFullPath);
                if (ok) {
                  updateRecordThumbnail(record.id, `thumbnails/${thumbFilename}`);
                  results.processed++;
                  results.details.push({ id: record.id, action: 'thumbnail', status: 'ok' });
                } else {
                  results.failed++;
                }
              }
            } catch (err) {
              results.failed++;
              results.details.push({ id: record.id, action: 'thumbnail', status: 'error', error: err.message });
            }
          } else if (mode === 'thumbnails' && record.thumbnailPath) {
            results.skipped++;
          }

          // 原圖轉 WebP（僅圖片）
          if ((mode === 'webp' || mode === 'both') && record.type === 'image') {
            const ext = path.extname(record.backupPath).toLowerCase();
            if (ext !== '.webp') {
              try {
                const webpFilename = record.backupPath.replace(/\.\w+$/, '.webp');
                const webpPath = path.join(DATA_DIR, webpFilename);

                await sharp(sourcePath)
                  .webp({ quality: 85 })
                  .toFile(webpPath);

                // 刪除原檔，更新記錄
                fs.unlinkSync(sourcePath);
                updateRecordBackupPath(record.id, webpFilename);
                results.processed++;
                results.details.push({ id: record.id, action: 'webp', status: 'ok' });
              } catch (err) {
                results.failed++;
                results.details.push({ id: record.id, action: 'webp', status: 'error', error: err.message });
              }
            } else {
              results.skipped++;
            }
          }
        }

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, ...results }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/optimize/status - 查詢優化狀態（缺少縮圖的數量等）
    if (req.method === 'GET' && urlPath === '/api/optimize/status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const records = readAllRecords();
      let missingThumbnails = 0;
      let nonWebpImages = 0;
      let totalImages = 0;
      let totalVideos = 0;

      for (const record of records) {
        const sourcePath = path.join(DATA_DIR, record.backupPath);
        if (!fs.existsSync(sourcePath)) continue;

        if (record.type === 'image') {
          totalImages++;
          if (!record.thumbnailPath) missingThumbnails++;
          if (!record.backupPath.endsWith('.webp')) nonWebpImages++;
        } else if (record.type === 'video') {
          totalVideos++;
          if (!record.thumbnailPath) missingThumbnails++;
        }
      }

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        totalImages,
        totalVideos,
        missingThumbnails,
        nonWebpImages,
        canOptimize: missingThumbnails > 0 || nonWebpImages > 0
      }));
      return;
    }

    // GET /api/stats - 公開基本統計（供 dashboard 使用）
    if (req.method === 'GET' && urlPath === '/api/stats') {
      const records = readAllRecords();
      const totalRecords = records.length;
      const totalVideos = records.filter(r => r.type === 'video').length;
      const totalImages = records.filter(r => r.type === 'image').length;

      // 如果是登入狀態，返回更多資訊
      if (isAdminAuthenticated(req)) {
        const urlCounts = {};
        records.forEach(r => {
          urlCounts[r.pageUrl] = (urlCounts[r.pageUrl] || 0) + 1;
        });
        const topUrls = Object.entries(urlCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([pageUrl, count]) => ({ pageUrl, count }));

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ total: totalRecords, totalRecords, totalVideos, totalImages, videos: totalVideos, images: totalImages, topUrls }));
        return;
      }

      // 公開版本只返回基本統計
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ totalRecords, totalVideos, totalImages }));
      return;
    }

    // ==================== 額度管理 API ====================

    // GET /api/quotas - 取得所有用戶額度列表
    if (req.method === 'GET' && urlPath === '/api/quotas') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const quotas = readAllQuotas().map(q => ({
        ...q,
        isVip: isVipVisitor(q.visitorId),
        remaining: getRemainingQuota(q),
        total: q.status === 'vip' || isVipVisitor(q.visitorId) ? '∞' : (q.freeQuota + (q.bonusQuota || 0))
      }));

      // 按最後使用時間排序
      quotas.sort((a, b) => {
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, quotas }));
      return;
    }

    // GET /api/quotas/:visitorId - 取得單一用戶詳情
    if (req.method === 'GET' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
      const quota = getVisitorQuota(visitorId);
      const remaining = getRemainingQuota(quota);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        quota: {
          ...quota,
          isVip: isVipVisitor(visitorId),
          remaining,
          total: quota.status === 'vip' || isVipVisitor(visitorId) ? '∞' : (quota.freeQuota + (quota.bonusQuota || 0))
        }
      }));
      return;
    }

    // POST /api/quotas/:visitorId - 更新用戶（配發額度、禁止、備註）
    if (req.method === 'POST' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const updates = {};
        if (body.bonusQuota !== undefined) updates.bonusQuota = parseInt(body.bonusQuota) || 0;
        if (body.status !== undefined && ['active', 'banned', 'vip'].includes(body.status)) {
          updates.status = body.status;
        }
        if (body.note !== undefined) updates.note = String(body.note);
        if (body.addBonus !== undefined) {
          const current = getVisitorQuota(visitorId);
          updates.bonusQuota = (current.bonusQuota || 0) + parseInt(body.addBonus);
        }

        const updated = updateQuota(visitorId, updates);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, quota: updated }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // DELETE /api/quotas/:visitorId - 刪除用戶記錄
    if (req.method === 'DELETE' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
      deleteQuota(visitorId);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== 兌換碼 API ====================

    // POST /api/redeem - 兌換序號（公開 API，不需登入）
    if (req.method === 'POST' && urlPath === '/api/redeem') {
      try {
        const body = await parseBody(req);
        const code = body.code?.trim();
        const visitorId = body.visitorId;

        if (!code || !visitorId) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少兌換碼或訪客 ID' }));
          return;
        }

        const result = redeemCode(code, visitorId);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/redemptions - 取得所有兌換碼（需要管理員權限）
    if (req.method === 'GET' && urlPath === '/api/redemptions') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const redemptions = readAllRedemptions();
      const stats = {
        total: redemptions.length,
        used: redemptions.filter(r => r.usedBy).length,
        unused: redemptions.filter(r => !r.usedBy).length,
        expired: redemptions.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date() && !r.usedBy).length
      };

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, redemptions, stats }));
      return;
    }

    // POST /api/redemptions/generate - 生成新兌換碼（需要管理員權限）
    if (req.method === 'POST' && urlPath === '/api/redemptions/generate') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const count = Math.min(parseInt(body.count) || 1, 100); // 最多一次 100 個
        const bonus = parseInt(body.bonus) || 5;
        const expiresAt = body.expiresAt || null;
        const note = body.note || '';

        const codes = createRedemptionCodes(count, bonus, expiresAt, note);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, codes }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // DELETE /api/redemptions/:code - 刪除兌換碼（需要管理員權限）
    if (req.method === 'DELETE' && urlPath.startsWith('/api/redemptions/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const code = decodeURIComponent(urlPath.replace('/api/redemptions/', ''));
      deleteRedemptionCode(code);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== 使用者管理 API ====================

    // GET /api/users - 取得所有使用者（含設備資訊、貢獻統計）
    if (req.method === 'GET' && urlPath === '/api/users') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const users = readAllQuotas().map(q => ({
        visitorId: q.visitorId,
        usedCount: q.usedCount,
        freeQuota: q.freeQuota,
        bonusQuota: q.bonusQuota || 0,
        status: q.status || 'active',
        note: q.note || '',
        isVip: isVipVisitor(q.visitorId),
        remaining: getRemainingQuota(q),
        total: q.status === 'vip' || isVipVisitor(q.visitorId) ? '∞' : (q.freeQuota + (q.bonusQuota || 0)),
        lastUsed: q.lastUsed,
        history: q.history || [],
        // 設備資訊（由腳本回報）
        device: q.device || null,
        // 貢獻統計
        contribution: q.contribution || null
      }));

      // 按最後使用時間排序
      users.sort((a, b) => {
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, users }));
      return;
    }

    // PATCH /api/users/:visitorId - 更新使用者
    if (req.method === 'PATCH' && urlPath.startsWith('/api/users/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/users/', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const updates = {};
        if (body.status !== undefined && ['active', 'banned', 'vip'].includes(body.status)) {
          updates.status = body.status;
        }
        if (body.note !== undefined) updates.note = String(body.note);
        if (body.addBonus !== undefined) {
          const current = getVisitorQuota(visitorId);
          updates.bonusQuota = (current.bonusQuota || 0) + parseInt(body.addBonus);
        }

        const updated = updateQuota(visitorId, updates);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, user: updated }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/users/:visitorId/device - 腳本回報設備資訊
    if (req.method === 'POST' && urlPath.match(/^\/api\/users\/[^/]+\/device$/)) {
      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/users/', '').replace('/device', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const device = {
          lastSeen: Date.now(),
          network: {
            type: body.networkType || null,
            downlink: body.downlink || null,
            rtt: body.rtt || null
          },
          hardware: {
            cores: body.cores || null,
            memory: body.memory || null
          },
          battery: {
            level: body.batteryLevel || null,
            charging: body.batteryCharging || null
          }
        };

        updateQuota(visitorId, { device });
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/logs - 取得最近操作日誌
    if (req.method === 'GET' && urlPath === '/api/logs') {
      const records = readAllRecords();
      // 將最近的記錄轉換為日誌格式
      const logs = records
        .slice(-50)
        .reverse()
        .map(r => ({
          time: r.capturedAt,  // 正確的欄位名稱
          type: r.backupStatus === 'completed' ? 'upload' : (r.backupStatus === 'failed' ? 'error' : 'view'),
          message: `${r.type === 'video' ? '影片' : '圖片'}: ${r.title || r.pageUrl}`
        }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ logs }));
      return;
    }

    // GET /api/logs/stream - SSE 即時日誌串流
    if (req.method === 'GET' && urlPath === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // 送出連接成功訊息
      res.write(`data: ${JSON.stringify({ type: 'connected', message: '已連接即時日誌' })}\n\n`);

      // 加入客戶端列表
      sseClients.add(res);
      console.log(`[lurl] SSE 客戶端連接，目前 ${sseClients.size} 個`);

      // 客戶端斷開時移除
      req.on('close', () => {
        sseClients.delete(res);
        console.log(`[lurl] SSE 客戶端斷開，剩餘 ${sseClients.size} 個`);
      });

      return;
    }

    // DELETE /api/records/:id (需要登入)
    if (req.method === 'DELETE' && urlPath.startsWith('/api/records/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.replace('/api/records/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      // 刪除檔案
      const filePath = path.join(DATA_DIR, record.backupPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // 更新記錄（過濾掉要刪除的）
      const newRecords = records.filter(r => r.id !== id);
      fs.writeFileSync(RECORDS_FILE, newRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 已刪除: ${record.title}`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/records/:id/vote (需要登入) - 投票（計數版）
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/vote$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const vote = body.vote; // 'like' | 'dislike'

      if (vote !== 'like' && vote !== 'dislike') {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Invalid vote value' }));
        return;
      }

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      const oldVote = record.myVote || null;

      // 初始化計數（舊記錄可能沒有）
      if (typeof record.likeCount !== 'number') record.likeCount = 0;
      if (typeof record.dislikeCount !== 'number') record.dislikeCount = 0;

      // 投票邏輯
      if (vote === oldVote) {
        // 點同一個 = 取消投票
        record.myVote = null;
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
      } else {
        // 點不同的 = 切換投票
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
        if (vote === 'like') record.likeCount++;
        if (vote === 'dislike') record.dislikeCount++;
        record.myVote = vote;
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 投票更新: ${record.title} -> ${record.myVote} (👍${record.likeCount} 👎${record.dislikeCount})`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        likeCount: record.likeCount,
        dislikeCount: record.dislikeCount,
        myVote: record.myVote
      }));
      return;
    }

    // POST /api/records/:id/block (需要登入) - 封鎖/解除封鎖
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/block$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const block = body.block; // true | false

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      let deleted = false;

      if (block) {
        // 封鎖：刪除本地檔案和縮圖，保留記錄
        record.blocked = true;
        record.blockedAt = new Date().toISOString();

        // 刪除主檔案
        const filePath = path.join(DATA_DIR, record.backupPath);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted = true;
        }

        // 刪除縮圖
        if (record.thumbnailPath) {
          const thumbPath = path.join(DATA_DIR, record.thumbnailPath);
          if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
          }
        }

        record.fileExists = false;
        console.log(`[lurl] 封鎖: ${record.title}`);
      } else {
        // 解除封鎖：清除封鎖狀態
        record.blocked = false;
        record.blockedAt = null;
        record.fileExists = false; // 需要重新下載
        console.log(`[lurl] 解除封鎖: ${record.title}`);
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, deleted }));
      return;
    }

    // PATCH /api/records/:id/tags (需要登入) - 更新標籤
    if (req.method === 'PATCH' && urlPath.match(/^\/api\/records\/[^/]+\/tags$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const { tags } = body;

      if (!Array.isArray(tags)) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'tags must be an array' }));
        return;
      }

      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Record not found' }));
        return;
      }

      record.tags = tags;
      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 標籤更新: ${record.title} -> [${tags.join(', ')}]`);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, tags: record.tags }));
      return;
    }

    // GET /api/tags - 取得所有可用標籤（階層式）
    if (req.method === 'GET' && urlPath === '/api/tags') {
      const TAG_TREE = {
        '奶子': ['穿衣', '裸體', '大奶', '露點'],
        '屁股': [],
        '鮑魚': [],
        '全身': [],
        '姿勢': ['女上', '傳教士', '背後'],
        '口交': []
      };
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ tagTree: TAG_TREE, mainTags: Object.keys(TAG_TREE) }));
      return;
    }

    // GET /api/blocked-urls (Client Token 驗證) - 給 Userscript 的封鎖清單
    if (req.method === 'GET' && urlPath === '/api/blocked-urls') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');

      if (token !== CLIENT_TOKEN && !isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const records = readAllRecords();
      const blockedUrls = records
        .filter(r => r.blocked)
        .map(r => r.fileUrl);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        urls: blockedUrls,
        count: blockedUrls.length,
        updatedAt: new Date().toISOString()
      }));
      return;
    }

    // ==================== 修復服務 API ====================

    // GET /api/check-backup - 檢查是否有備份（公開，用 visitorId）
    if (req.method === 'GET' && urlPath === '/api/check-backup') {
      const pageUrl = query.url;
      const visitorId = req.headers['x-visitor-id'];

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing url parameter' }));
        return;
      }

      // 從 URL 提取 ID（尾部），例如 https://lurl.cc/B0Fe7 → B0Fe7
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();

      const records = readAllRecords();

      // 用 ID 匹配（大小寫不敏感），而非完整 URL
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      // 檢查本地檔案是否存在
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const fileExists = fs.existsSync(localFilePath);

      if (!fileExists) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      const backupUrl = `/lurl/files/${record.backupPath}`;

      // 檢查是否已修復過（不扣點直接給 URL）
      if (visitorId) {
        const recoveredEntry = hasRecovered(visitorId, urlId);
        if (recoveredEntry) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            hasBackup: true,
            alreadyRecovered: true,
            backupUrl,
            record: {
              id: record.id,
              title: record.title,
              type: record.type
            }
          }));
          return;
        }
      }

      // 取得額度資訊
      const quota = visitorId ? getVisitorQuota(visitorId) : { usedCount: 0, freeQuota: FREE_QUOTA, paidQuota: 0 };
      const remaining = getRemainingQuota(quota);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        hasBackup: true,
        alreadyRecovered: false,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining,
          total: quota.freeQuota + quota.paidQuota
        }
      }));
      return;
    }

    // POST /api/recover - 執行修復（消耗額度，冪等性：已修復過不重複扣點）
    if (req.method === 'POST' && urlPath === '/api/recover') {
      const visitorId = req.headers['x-visitor-id'];
      const body = await parseBody(req);
      const pageUrl = body.pageUrl;

      if (!visitorId) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing X-Visitor-Id header' }));
        return;
      }

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing pageUrl' }));
        return;
      }

      // 找備份（用 ID 匹配，大小寫不敏感）
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();
      const records = readAllRecords();
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'No backup found' }));
        return;
      }

      const localFilePath = path.join(DATA_DIR, record.backupPath);
      if (!fs.existsSync(localFilePath)) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Backup file not found' }));
        return;
      }

      const backupUrl = `/lurl/files/${record.backupPath}`;

      // 冪等性：檢查是否已修復過
      const recoveredEntry = hasRecovered(visitorId, urlId);
      if (recoveredEntry) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          alreadyRecovered: true,
          backupUrl,
          record: {
            id: record.id,
            title: record.title,
            type: record.type
          }
        }));
        return;
      }

      // 檢查額度
      const quota = getVisitorQuota(visitorId);
      const remaining = getRemainingQuota(quota);

      if (remaining === 0) {
        // -1 = 無限 (VIP)，0 = 用完或封禁，>0 = 還有額度
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: false,
          error: 'quota_exhausted',
          message: '免費額度已用完'
        }));
        return;
      }

      // 扣額度（帶入 urlId 和 backupUrl）
      const newQuota = useQuota(visitorId, pageUrl, urlId, backupUrl);
      const newRemaining = getRemainingQuota(newQuota);

      console.log(`[lurl] 修復服務: ${record.title} (visitor: ${visitorId.substring(0, 8)}..., 剩餘: ${newRemaining})`);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        backupUrl: `/lurl/files/${record.backupPath}`,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining: newRemaining,
          total: newQuota.freeQuota + newQuota.paidQuota
        }
      }));
      return;
    }

    // ==================== Phase 3 ====================

    // GET /browse (需要登入)
    if (req.method === 'GET' && urlPath === '/browse') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/browse' });
        res.end();
        return;
      }
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(browsePage());
      return;
    }

    // GET /view/:id (需要登入)
    if (req.method === 'GET' && urlPath.startsWith('/view/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': `/lurl/login?redirect=/lurl${urlPath}` });
        res.end();
        return;
      }
      const id = urlPath.replace('/view/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders('text/html; charset=utf-8'));
        res.end('<h1>404 - 找不到此內容</h1><a href="javascript:history.back()">返回影片庫</a>');
        return;
      }

      // 檢查本地檔案是否存在
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const fileExists = fs.existsSync(localFilePath);

      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(viewPage(record, fileExists));
      return;
    }

    // POST /api/retry/:id - 重新下載檔案 (需要登入)
    if (req.method === 'POST' && urlPath.startsWith('/api/retry/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.replace('/api/retry/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
      const localFilePath = path.join(DATA_DIR, record.backupPath);

      // 用 pageUrl 當 Referer 來下載
      const success = await downloadFile(record.fileUrl, localFilePath, record.pageUrl);

      if (success) {
        console.log(`[lurl] 重試下載成功: ${record.title}`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '下載失敗，CDN 可能已過期' }));
      }
      return;
    }

    // GET/HEAD /hls/:recordId/* - HLS 串流檔案
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/hls/')) {
      const hlsPath = decodeURIComponent(urlPath.replace('/hls/', ''));
      const fullHlsPath = path.join(HLS_DIR, hlsPath);

      if (!fs.existsSync(fullHlsPath) || fs.statSync(fullHlsPath).isDirectory()) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'HLS file not found' }));
        return;
      }

      const ext = path.extname(fullHlsPath).toLowerCase();
      const mimeTypes = {
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullHlsPath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': ext === '.m3u8' ? 'no-cache' : 'public, max-age=31536000, immutable'
      });

      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(fullHlsPath).pipe(res);
      }
      return;
    }

    // POST /api/hls/transcode/:id - 觸發 HLS 轉檔
    if (req.method === 'POST' && urlPath.startsWith('/api/hls/transcode/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const recordId = urlPath.replace('/api/hls/transcode/', '');
      queueHLSTranscode(recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, message: '已加入轉檔佇列' }));
      return;
    }

    // POST /api/hls/transcode-all - 批次轉檔所有影片
    if (req.method === 'POST' && urlPath === '/api/hls/transcode-all') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const records = readAllRecords();
      const videos = records.filter(r => r.type === 'video' && r.fileExists !== false && !r.hlsReady);
      videos.forEach(r => queueHLSTranscode(r.id));
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, queued: videos.length }));
      return;
    }

    // GET /api/hls/status - 取得 HLS 轉檔狀態
    if (req.method === 'GET' && urlPath === '/api/hls/status') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify(getHLSStatus()));
      return;
    }

    // GET/HEAD /files/videos/:filename 或 /files/images/:filename
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/files/')) {
      const filePath = decodeURIComponent(urlPath.replace('/files/', '')); // URL decode 中文檔名

      // 防止讀取資料夾
      if (!filePath || filePath.endsWith('/') || !filePath.includes('.')) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Invalid file path' }));
        return;
      }

      const fullFilePath = path.join(DATA_DIR, filePath);

      if (!fs.existsSync(fullFilePath) || fs.statSync(fullFilePath).isDirectory()) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      const ext = path.extname(fullFilePath).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullFilePath);
      const fileSize = stat.size;

      // 支援 Range 請求（影片串流必需）
      const range = req.headers.range;
      if (range && contentType.startsWith('video/')) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath, { start, end }).pipe(res);
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath).pipe(res);
        }
      }
      return;
    }

    // 404
    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
