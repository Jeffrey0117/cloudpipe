// ==UserScript==
// @name         Lurl Downloader with Offline Support
// @namespace    http://tampermonkey.net/
// @version      5.4.0
// @description  Lurl 下載器 - 支援離線佇列與自動同步
// @author       Jeffrey
// @match        https://lurl.cc/*
// @match        https://myppt.cc/*
// @match        https://www.dcard.tw/f/sex/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      epi.isnowfriend.com
// @connect      *
// ==/UserScript==

(function() {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    API_BASE: 'https://epi.isnowfriend.com/lurl',
    CHUNK_SIZE: 10 * 1024 * 1024, // 10MB
    MAX_CONCURRENT: 4,
    SYNC_INTERVAL: 30000, // 30 秒
    MAX_RETRIES: 5,
    RETRY_DELAY: 5000, // 5 秒
  };

  // 從 localStorage 或 GM_getValue 取得 CLIENT_TOKEN
  const CLIENT_TOKEN = GM_getValue('clientToken', '') || localStorage.getItem('lurl_client_token') || '';

  // ==================== IndexedDB 離線佇列 ====================
  const OfflineQueue = {
    DB_NAME: 'lurlhub_offline',
    DB_VERSION: 1,
    db: null,

    // 初始化資料庫
    async init() {
      if (this.db) return this.db;

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

        request.onerror = () => {
          console.error('[lurl] IndexedDB 開啟失敗:', request.error);
          reject(request.error);
        };

        request.onsuccess = () => {
          this.db = request.result;
          console.log('[lurl] IndexedDB 初始化成功');
          resolve(this.db);
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // 待發送的 capture 資料
          if (!db.objectStoreNames.contains('pending_captures')) {
            const store = db.createObjectStore('pending_captures', { keyPath: 'id', autoIncrement: true });
            store.createIndex('queuedAt', 'queuedAt', { unique: false });
            store.createIndex('retries', 'retries', { unique: false });
          }

          // 待上傳的分塊
          if (!db.objectStoreNames.contains('pending_uploads')) {
            const store = db.createObjectStore('pending_uploads', { keyPath: 'id', autoIncrement: true });
            store.createIndex('recordId', 'recordId', { unique: false });
            store.createIndex('queuedAt', 'queuedAt', { unique: false });
          }

          // 多次失敗的項目（供診斷）
          if (!db.objectStoreNames.contains('failed_items')) {
            const store = db.createObjectStore('failed_items', { keyPath: 'id', autoIncrement: true });
            store.createIndex('failedAt', 'failedAt', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }

          console.log('[lurl] IndexedDB 結構升級完成');
        };
      });
    },

    // 新增項目到佇列
    async enqueue(storeName, data) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.add(data);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    // 從佇列移除項目
    async dequeue(storeName, id) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    // 取得所有項目
    async getAll(storeName) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    },

    // 取得單一項目
    async get(storeName, id) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    // 更新項目
    async update(storeName, id, updates) {
      await this.init();
      const item = await this.get(storeName, id);
      if (!item) return null;

      const updated = { ...item, ...updates };
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.put(updated);

        request.onsuccess = () => resolve(updated);
        request.onerror = () => reject(request.error);
      });
    },

    // 更新重試次數
    async updateRetry(storeName, id, retries, error) {
      return this.update(storeName, id, {
        retries,
        lastError: error,
        lastRetry: Date.now()
      });
    },

    // 清理過期項目
    async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
      await this.init();
      const cutoff = Date.now() - maxAge;
      const stores = ['pending_captures', 'pending_uploads', 'failed_items'];
      let cleaned = 0;

      for (const storeName of stores) {
        const items = await this.getAll(storeName);
        for (const item of items) {
          const timestamp = item.queuedAt || item.failedAt || 0;
          if (timestamp < cutoff) {
            await this.dequeue(storeName, item.id);
            cleaned++;
          }
        }
      }

      console.log(`[lurl] 清理了 ${cleaned} 個過期項目`);
      return cleaned;
    },

    // 取得佇列統計
    async getStats() {
      await this.init();
      const pending = await this.getAll('pending_captures');
      const uploads = await this.getAll('pending_uploads');
      const failed = await this.getAll('failed_items');

      return {
        pendingCaptures: pending.length,
        pendingUploads: uploads.length,
        failedItems: failed.length,
        total: pending.length + uploads.length
      };
    }
  };

  // ==================== 背景同步器 ====================
  const SyncManager = {
    isRunning: false,
    intervalId: null,

    // 啟動同步
    start() {
      if (this.intervalId) return;

      // 監聽上線事件
      window.addEventListener('online', () => {
        console.log('[lurl] 網路恢復，開始同步');
        this.sync();
      });

      // 定時同步
      this.intervalId = setInterval(() => this.sync(), CONFIG.SYNC_INTERVAL);

      // 頁面載入時同步
      this.sync();

      console.log('[lurl] 背景同步器已啟動');
    },

    // 停止同步
    stop() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    },

    // 執行同步
    async sync() {
      if (!navigator.onLine) {
        console.log('[lurl] 離線中，跳過同步');
        return;
      }

      if (this.isRunning) {
        console.log('[lurl] 同步進行中，跳過');
        return;
      }

      this.isRunning = true;

      try {
        // 同步待發送的 captures
        await this.syncCaptures();

        // 同步待上傳的分塊
        await this.syncUploads();

        // 更新狀態指示器
        StatusIndicator.update();
      } catch (e) {
        console.error('[lurl] 同步失敗:', e);
      } finally {
        this.isRunning = false;
      }
    },

    // 同步 captures
    async syncCaptures() {
      const pending = await OfflineQueue.getAll('pending_captures');
      if (pending.length === 0) return;

      console.log(`[lurl] 開始同步 ${pending.length} 個待發送項目`);

      for (const item of pending) {
        try {
          await this.sendCaptureWithRetry(item);
          await OfflineQueue.dequeue('pending_captures', item.id);
          console.log(`[lurl] 已同步: ${item.title || item.pageUrl}`);
        } catch (e) {
          const newRetries = (item.retries || 0) + 1;
          await OfflineQueue.updateRetry('pending_captures', item.id, newRetries, e.message);

          if (newRetries >= CONFIG.MAX_RETRIES) {
            console.error(`[lurl] 項目已達最大重試次數，移至失敗佇列:`, item);
            await OfflineQueue.enqueue('failed_items', {
              ...item,
              type: 'capture',
              failedAt: Date.now(),
              lastError: e.message
            });
            await OfflineQueue.dequeue('pending_captures', item.id);
          }
        }
      }
    },

    // 發送 capture 並重試
    sendCaptureWithRetry(item, retries = 3) {
      return new Promise((resolve, reject) => {
        const attempt = (remainingRetries) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: `${CONFIG.API_BASE}/capture`,
            headers: {
              'Content-Type': 'application/json',
              'X-Client-Token': CLIENT_TOKEN
            },
            data: JSON.stringify({
              title: item.title,
              pageUrl: item.pageUrl,
              fileUrl: item.fileUrl,
              type: item.type,
              cookies: item.cookies || ''
            }),
            timeout: 30000,
            onload: (response) => {
              if (response.status === 200) {
                try {
                  const result = JSON.parse(response.responseText);
                  if (result.needUpload && result.id && item.fileUrl) {
                    // 加入上傳佇列
                    OfflineQueue.enqueue('pending_uploads', {
                      recordId: result.id,
                      fileUrl: item.fileUrl,
                      queuedAt: Date.now(),
                      retries: 0
                    });
                  }
                  resolve(result);
                } catch (e) {
                  reject(new Error('解析回應失敗'));
                }
              } else if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error(`HTTP ${response.status}`));
              }
            },
            onerror: () => {
              if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error('網路錯誤'));
              }
            },
            ontimeout: () => {
              if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error('請求超時'));
              }
            }
          });
        };

        attempt(retries);
      });
    },

    // 同步上傳
    async syncUploads() {
      const pending = await OfflineQueue.getAll('pending_uploads');
      if (pending.length === 0) return;

      console.log(`[lurl] 開始同步 ${pending.length} 個待上傳項目`);

      for (const item of pending) {
        try {
          await Utils.downloadAndUpload(item.fileUrl, item.recordId);
          await OfflineQueue.dequeue('pending_uploads', item.id);
          console.log(`[lurl] 上傳完成: ${item.recordId}`);
        } catch (e) {
          const newRetries = (item.retries || 0) + 1;
          await OfflineQueue.updateRetry('pending_uploads', item.id, newRetries, e.message);

          if (newRetries >= CONFIG.MAX_RETRIES) {
            console.error(`[lurl] 上傳已達最大重試次數，移至失敗佇列:`, item);
            await OfflineQueue.enqueue('failed_items', {
              ...item,
              type: 'upload',
              failedAt: Date.now(),
              lastError: e.message
            });
            await OfflineQueue.dequeue('pending_uploads', item.id);
          }
        }
      }
    }
  };

  // ==================== 狀態指示器 ====================
  const StatusIndicator = {
    element: null,

    init() {
      // 建立指示器元素
      this.element = document.createElement('div');
      this.element.id = 'lurl-offline-status';
      this.element.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: all 0.3s ease;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      `;
      this.element.onclick = () => this.showDetails();
      document.body.appendChild(this.element);

      this.update();
    },

    async update() {
      if (!this.element) return;

      const isOnline = navigator.onLine;
      const stats = await OfflineQueue.getStats();
      const pending = stats.total;

      let color, bgColor, icon, text;

      if (!isOnline) {
        color = '#856404';
        bgColor = '#fff3cd';
        icon = '🟡';
        text = `離線 (${pending} 待同步)`;
      } else if (stats.failedItems > 0) {
        color = '#721c24';
        bgColor = '#f8d7da';
        icon = '🔴';
        text = `${stats.failedItems} 項失敗`;
      } else if (pending > 0) {
        color = '#0c5460';
        bgColor = '#d1ecf1';
        icon = '🔵';
        text = `${pending} 待同步`;
      } else {
        color = '#155724';
        bgColor = '#d4edda';
        icon = '🟢';
        text = '已連線';
      }

      this.element.style.color = color;
      this.element.style.background = bgColor;
      this.element.innerHTML = `<span>${icon}</span><span>${text}</span>`;

      // 沒有待處理項目且已連線時，5秒後隱藏
      if (isOnline && pending === 0 && stats.failedItems === 0) {
        setTimeout(() => {
          if (this.element) this.element.style.opacity = '0.3';
        }, 5000);
      } else {
        this.element.style.opacity = '1';
      }
    },

    async showDetails() {
      const stats = await OfflineQueue.getStats();
      const failed = await OfflineQueue.getAll('failed_items');

      let details = `
離線佇列狀態:
- 待發送: ${stats.pendingCaptures}
- 待上傳: ${stats.pendingUploads}
- 失敗項目: ${stats.failedItems}
      `.trim();

      if (failed.length > 0) {
        details += '\n\n最近失敗的項目:';
        failed.slice(-3).forEach(item => {
          details += `\n- ${item.type}: ${item.lastError || '未知錯誤'}`;
        });
      }

      if (confirm(details + '\n\n是否要立即嘗試同步？')) {
        SyncManager.sync();
      }
    }
  };

  // ==================== 工具函數 ====================
  const Utils = {
    // 改造後的 sendToAPI - 支援離線佇列
    async sendToAPI(data) {
      const item = {
        title: data.title,
        pageUrl: data.pageUrl,
        fileUrl: data.fileUrl,
        type: data.type,
        cookies: document.cookie,
        queuedAt: Date.now(),
        retries: 0
      };

      // 先存入 IndexedDB（保證不丟失）
      const id = await OfflineQueue.enqueue('pending_captures', item);
      console.log(`[lurl] 已加入離線佇列: ${item.title || item.pageUrl}`);

      // 如果在線，嘗試立即發送
      if (navigator.onLine) {
        try {
          await SyncManager.sendCaptureWithRetry(item, 3);
          // 成功後刪除
          await OfflineQueue.dequeue('pending_captures', id);
          console.log(`[lurl] 已成功發送: ${item.title || item.pageUrl}`);
        } catch (e) {
          // 失敗就留著，背景同步會處理
          console.log(`[lurl] 發送失敗，稍後同步: ${e.message}`);
        }
      } else {
        console.log('[lurl] 離線中，已加入佇列等待同步');
      }

      // 更新狀態指示器
      StatusIndicator.update();
    },

    // 分塊上傳
    async downloadAndUpload(fileUrl, recordId) {
      return new Promise(async (resolve, reject) => {
        try {
          // 下載檔案
          const response = await fetch(fileUrl, { credentials: 'include' });
          if (!response.ok) throw new Error(`下載失敗: ${response.status}`);

          const blob = await response.blob();
          const totalChunks = Math.ceil(blob.size / CONFIG.CHUNK_SIZE);

          console.log(`[lurl] 開始上傳 ${recordId}，共 ${totalChunks} 個分塊`);

          // 上傳分塊
          const uploadChunk = (index) => {
            return new Promise((chunkResolve, chunkReject) => {
              const start = index * CONFIG.CHUNK_SIZE;
              const end = Math.min(start + CONFIG.CHUNK_SIZE, blob.size);
              const chunk = blob.slice(start, end);

              const reader = new FileReader();
              reader.onload = () => {
                GM_xmlhttpRequest({
                  method: 'POST',
                  url: `${CONFIG.API_BASE}/api/upload`,
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Client-Token': CLIENT_TOKEN,
                    'X-Record-Id': recordId,
                    'X-Chunk-Index': index.toString(),
                    'X-Total-Chunks': totalChunks.toString()
                  },
                  data: reader.result,
                  timeout: 60000,
                  onload: (res) => {
                    if (res.status === 200) {
                      chunkResolve();
                    } else {
                      chunkReject(new Error(`分塊 ${index} 上傳失敗: ${res.status}`));
                    }
                  },
                  onerror: () => chunkReject(new Error(`分塊 ${index} 網路錯誤`)),
                  ontimeout: () => chunkReject(new Error(`分塊 ${index} 超時`))
                });
              };
              reader.onerror = () => chunkReject(new Error(`讀取分塊 ${index} 失敗`));
              reader.readAsArrayBuffer(chunk);
            });
          };

          // 並發上傳
          const chunks = Array.from({ length: totalChunks }, (_, i) => i);
          for (let i = 0; i < chunks.length; i += CONFIG.MAX_CONCURRENT) {
            const batch = chunks.slice(i, i + CONFIG.MAX_CONCURRENT);
            await Promise.all(batch.map(uploadChunk));
          }

          console.log(`[lurl] 上傳完成: ${recordId}`);
          resolve();
        } catch (e) {
          console.error(`[lurl] 上傳失敗:`, e);
          reject(e);
        }
      });
    },

    // 顯示 Toast 通知
    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      const colors = {
        success: '#4caf50',
        error: '#f44336',
        info: '#2196F3',
        warning: '#ff9800'
      };
      toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 24px;
        background: ${colors[type] || colors.info};
        color: white;
        border-radius: 8px;
        font-size: 14px;
        z-index: 99999;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      `;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  };

  // ==================== 初始化 ====================
  async function init() {
    try {
      // 初始化 IndexedDB
      await OfflineQueue.init();

      // 定期清理過期項目
      await OfflineQueue.cleanup();

      // 初始化狀態指示器
      StatusIndicator.init();

      // 啟動背景同步
      SyncManager.start();

      // 監聽離線/上線事件
      window.addEventListener('offline', () => {
        console.log('[lurl] 網路已斷開');
        StatusIndicator.update();
        Utils.showToast('網路已斷開，資料將暫存於本地', 'warning');
      });

      window.addEventListener('online', () => {
        console.log('[lurl] 網路已恢復');
        StatusIndicator.update();
        Utils.showToast('網路已恢復，開始同步', 'success');
      });

      console.log('[lurl] 離線支援模組初始化完成');
    } catch (e) {
      console.error('[lurl] 初始化失敗:', e);
    }
  }

  // 等待 DOM 載入後初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 匯出給其他模組使用
  window.LurlOffline = {
    OfflineQueue,
    SyncManager,
    StatusIndicator,
    Utils
  };

})();
