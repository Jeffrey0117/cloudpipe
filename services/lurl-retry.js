/**
 * Lurl 備援下載模組
 * 使用 Puppeteer 重新抓取失敗的媒體檔案
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 設定
const CONFIG = {
  timeout: 30000,         // 頁面載入超時
  downloadTimeout: 60000, // 下載超時
  maxRetries: 3,          // 最大重試次數
  retryDelay: 2000,       // 重試間隔 (ms)
};

let browser = null;

/**
 * 初始化瀏覽器
 */
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });
    console.log('[lurl-retry] Puppeteer 瀏覽器已啟動');
  }
  return browser;
}

/**
 * 關閉瀏覽器
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('[lurl-retry] Puppeteer 瀏覽器已關閉');
  }
}

/**
 * 從頁面抓取媒體 URL
 * @param {string} pageUrl - lurl.cc 或 myppt.cc 頁面網址
 * @returns {Promise<{fileUrl: string, type: string, title: string}>}
 */
async function extractMediaFromPage(pageUrl) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  try {
    // 設定 User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 設定視窗大小
    await page.setViewport({ width: 1280, height: 720 });

    console.log(`[lurl-retry] 正在載入頁面: ${pageUrl}`);

    // 載入頁面
    await page.goto(pageUrl, {
      waitUntil: 'networkidle2',
      timeout: CONFIG.timeout,
    });

    // 等待一下讓動態內容載入
    await page.waitForTimeout(2000);

    // 嘗試抓取媒體 URL
    const mediaInfo = await page.evaluate(() => {
      // 找影片
      const video = document.querySelector('video source') || document.querySelector('video');
      if (video) {
        const src = video.src || video.querySelector('source')?.src;
        if (src && (src.includes('.mp4') || src.includes('.mov') || src.includes('.m3u8'))) {
          return {
            fileUrl: src,
            type: 'video',
            title: document.title || 'untitled',
          };
        }
      }

      // 找圖片 (主要內容區)
      const selectors = [
        '.media-content img',
        '.post-content img',
        '.content img',
        'article img',
        '.main img',
        'img[src*="lurl"]',
        'img[src*="myppt"]',
      ];

      for (const selector of selectors) {
        const img = document.querySelector(selector);
        if (img && img.src && !img.src.includes('avatar') && !img.src.includes('logo')) {
          // 檢查是否是 CDN 圖片
          if (img.src.includes('.jpg') || img.src.includes('.png') || img.src.includes('.gif') || img.src.includes('.webp')) {
            return {
              fileUrl: img.src,
              type: 'image',
              title: document.title || 'untitled',
            };
          }
        }
      }

      // Fallback: 找最大的圖片
      const images = Array.from(document.querySelectorAll('img'));
      const mainImage = images
        .filter(img => img.naturalWidth > 200 && img.naturalHeight > 200)
        .filter(img => !img.src.includes('avatar') && !img.src.includes('logo') && !img.src.includes('icon'))
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];

      if (mainImage) {
        return {
          fileUrl: mainImage.src,
          type: 'image',
          title: document.title || 'untitled',
        };
      }

      return null;
    });

    if (!mediaInfo) {
      throw new Error('無法在頁面中找到媒體');
    }

    console.log(`[lurl-retry] 找到媒體: ${mediaInfo.type} - ${mediaInfo.fileUrl.substring(0, 80)}...`);
    return mediaInfo;

  } finally {
    await page.close();
  }
}

/**
 * 下載檔案
 * @param {string} url - 檔案 URL
 * @param {string} destPath - 目標路徑
 * @param {string} pageUrl - 來源頁面 (用於 referer)
 */
async function downloadFile(url, destPath, pageUrl = '') {
  return new Promise((resolve, reject) => {
    // 決定 referer
    let referer = 'https://lurl.cc/';
    if (url.includes('myppt.cc')) {
      referer = 'https://myppt.cc/';
    }

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Accept': '*/*',
      },
      timeout: CONFIG.downloadTimeout,
    };

    const protocol = url.startsWith('https') ? https : http;

    // 確保目錄存在
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const file = fs.createWriteStream(destPath);

    const request = protocol.get(url, options, (response) => {
      // 處理重定向
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath, pageUrl)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`下載失敗: HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(destPath);
        if (stats.size < 1000) {
          fs.unlinkSync(destPath);
          reject(new Error('檔案太小，可能下載失敗'));
        } else {
          console.log(`[lurl-retry] 下載完成: ${destPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          resolve({ size: stats.size, path: destPath });
        }
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(err);
    });

    request.on('timeout', () => {
      request.destroy();
      file.close();
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(new Error('下載超時'));
    });
  });
}

/**
 * 重試下載失敗的記錄
 * @param {object} record - 記錄物件 { id, pageUrl, fileUrl, type, backupPath }
 * @param {string} dataDir - 資料目錄
 * @returns {Promise<{success: boolean, message: string, newFileUrl?: string}>}
 */
async function retryDownload(record, dataDir) {
  console.log(`[lurl-retry] 開始重試: ${record.id} - ${record.pageUrl}`);

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      // 1. 用 Puppeteer 從頁面抓取最新的媒體 URL
      const mediaInfo = await extractMediaFromPage(record.pageUrl);

      // 2. 下載檔案
      const destPath = path.join(dataDir, record.backupPath);
      await downloadFile(mediaInfo.fileUrl, destPath, record.pageUrl);

      return {
        success: true,
        message: `第 ${attempt} 次嘗試成功`,
        newFileUrl: mediaInfo.fileUrl,
      };

    } catch (err) {
      console.error(`[lurl-retry] 第 ${attempt} 次嘗試失敗:`, err.message);

      if (attempt < CONFIG.maxRetries) {
        console.log(`[lurl-retry] ${CONFIG.retryDelay / 1000} 秒後重試...`);
        await new Promise(r => setTimeout(r, CONFIG.retryDelay));
      }
    }
  }

  return {
    success: false,
    message: `${CONFIG.maxRetries} 次嘗試都失敗`,
  };
}

/**
 * 批次重試多個失敗記錄
 * @param {array} records - 記錄陣列
 * @param {string} dataDir - 資料目錄
 * @param {function} onProgress - 進度回調 (current, total, record, result)
 */
async function batchRetry(records, dataDir, onProgress = null) {
  const results = {
    total: records.length,
    success: 0,
    failed: 0,
    details: [],
  };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const result = await retryDownload(record, dataDir);

    if (result.success) {
      results.success++;
    } else {
      results.failed++;
    }

    results.details.push({
      id: record.id,
      pageUrl: record.pageUrl,
      ...result,
    });

    if (onProgress) {
      onProgress(i + 1, records.length, record, result);
    }

    // 避免太頻繁請求
    if (i < records.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return results;
}

module.exports = {
  initBrowser,
  closeBrowser,
  extractMediaFromPage,
  downloadFile,
  retryDownload,
  batchRetry,
  CONFIG,
};
