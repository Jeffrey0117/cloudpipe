/**
 * MaintenanceScheduler - 維護任務調度器
 *
 * 功能：
 * - 定時執行維護策略
 * - 優先級調度
 * - 並行控制
 * - 狀態追蹤
 * - 配置持久化
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// 預設配置
const DEFAULT_CONFIG = {
  autoRun: false,
  runInterval: 60 * 60 * 1000, // 預設每小時
  maxConcurrent: 1,
  strategies: {
    download: { enabled: true, priority: 1 },
    thumbnail: { enabled: true, priority: 2 },
    preview: { enabled: true, priority: 3 },
    hls: { enabled: true, priority: 4 },
    cleanup: { enabled: true, priority: 5 },
  },
};

/**
 * 延遲函數
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MaintenanceScheduler extends EventEmitter {
  /**
   * @param {object} options - 配置選項
   * @param {string} options.dataDir - 資料目錄
   * @param {function} options.readAllRecords - 讀取所有記錄的函數
   * @param {function} options.updateRecord - 更新記錄的函數
   * @param {RecordChecker} options.checker - 記錄檢查器
   */
  constructor(options = {}) {
    super();

    this.dataDir = options.dataDir;
    this.readAllRecords = options.readAllRecords;
    this.updateRecord = options.updateRecord;
    this.checker = options.checker;
    this.context = options.context || {};

    this.strategies = new Map();
    this.isRunning = false;
    this.currentTask = null;
    this.history = [];
    this.maxHistorySize = 100;
    this.timer = null;
    this.nextRunTime = null;

    this.config = this.loadConfig(options.config);
  }

  /**
   * 從設定檔載入配置
   */
  loadConfig(overrides = {}) {
    const configPath = path.join(this.dataDir, 'maintenance-config.json');
    let saved = {};

    try {
      if (fs.existsSync(configPath)) {
        saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (err) {
      console.error('[Maintenance] 載入配置失敗:', err.message);
    }

    return { ...DEFAULT_CONFIG, ...saved, ...overrides };
  }

  /**
   * 儲存配置
   */
  saveConfig() {
    const configPath = path.join(this.dataDir, 'maintenance-config.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    } catch (err) {
      console.error('[Maintenance] 儲存配置失敗:', err.message);
    }
  }

  /**
   * 更新配置
   */
  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.saveConfig();

    // 更新策略配置
    if (updates.strategies) {
      for (const [name, strategyConfig] of Object.entries(updates.strategies)) {
        const strategy = this.strategies.get(name);
        if (strategy) {
          strategy.updateConfig(strategyConfig);
        }
      }
    }

    // 重啟排程器
    this.stopAutoRun();
    if (this.config.autoRun) {
      this.startAutoRun();
    }

    this.emit('configUpdated', this.config);
    return this.config;
  }

  /**
   * 註冊策略
   */
  register(strategy) {
    this.strategies.set(strategy.name, strategy);

    // 如果配置中有此策略的設定，套用它
    const strategyConfig = this.config.strategies?.[strategy.name];
    if (strategyConfig) {
      strategy.updateConfig(strategyConfig);
    }

    console.log(`[Maintenance] 已註冊策略: ${strategy.name} (優先級: ${strategy.priority})`);
    return this;
  }

  /**
   * 取消註冊策略
   */
  unregister(name) {
    this.strategies.delete(name);
    return this;
  }

  /**
   * 取得所有待處理統計
   */
  async getStatus() {
    const records = this.readAllRecords();
    const status = {};

    for (const [name, strategy] of this.strategies) {
      try {
        const pending = await strategy.getPendingRecords(records, this.checker);
        status[name] = {
          enabled: strategy.enabled,
          priority: strategy.priority,
          pending: pending.length,
          lastRun: strategy.lastRun,
          lastResult: strategy.lastResult,
        };
      } catch (err) {
        status[name] = {
          enabled: strategy.enabled,
          priority: strategy.priority,
          pending: 0,
          error: err.message,
        };
      }
    }

    return {
      isRunning: this.isRunning,
      currentTask: this.currentTask,
      strategies: status,
      nextRun: this.nextRunTime,
      config: this.config,
      historyCount: this.history.length,
    };
  }

  /**
   * 執行所有啟用的策略
   */
  async runAll() {
    if (this.isRunning) {
      return { error: 'Already running', isRunning: true };
    }

    this.isRunning = true;
    this.emit('runStart');

    const startTime = Date.now();
    const results = {};

    // 按優先級排序
    const sorted = [...this.strategies.values()]
      .filter((s) => s.enabled)
      .sort((a, b) => a.priority - b.priority);

    console.log(`[Maintenance] 開始執行 ${sorted.length} 個策略`);

    for (const strategy of sorted) {
      this.currentTask = strategy.name;
      this.emit('strategyStart', strategy.name);

      try {
        results[strategy.name] = await this.runStrategy(strategy);
      } catch (err) {
        results[strategy.name] = {
          processed: 0,
          success: 0,
          failed: 0,
          error: err.message,
        };
        console.error(`[Maintenance] 策略 ${strategy.name} 執行失敗:`, err);
      }

      this.emit('strategyComplete', strategy.name, results[strategy.name]);
    }

    this.isRunning = false;
    this.currentTask = null;

    const duration = Date.now() - startTime;
    this.logHistory('runAll', results, duration);

    console.log(`[Maintenance] 全部完成，耗時 ${(duration / 1000).toFixed(1)}s`);
    this.emit('runComplete', results);

    return results;
  }

  /**
   * 執行單一策略（可指定名稱）
   */
  async runOne(strategyName) {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      return { error: `Strategy not found: ${strategyName}` };
    }

    if (this.isRunning) {
      return { error: 'Already running', isRunning: true };
    }

    this.isRunning = true;
    this.currentTask = strategyName;
    this.emit('runStart');
    this.emit('strategyStart', strategyName);

    const startTime = Date.now();
    let result;

    try {
      result = await this.runStrategy(strategy);
    } catch (err) {
      result = {
        processed: 0,
        success: 0,
        failed: 0,
        error: err.message,
      };
    }

    this.isRunning = false;
    this.currentTask = null;

    const duration = Date.now() - startTime;
    this.logHistory(strategyName, { [strategyName]: result }, duration);

    this.emit('strategyComplete', strategyName, result);
    this.emit('runComplete', { [strategyName]: result });

    return result;
  }

  /**
   * 執行策略
   */
  async runStrategy(strategy) {
    const records = this.readAllRecords();
    const pending = await strategy.getPendingRecords(records, this.checker);

    if (pending.length === 0) {
      console.log(`[Maintenance] ${strategy.name}: 無待處理項目`);
      return { processed: 0, success: 0, failed: 0 };
    }

    console.log(`[Maintenance] ${strategy.name}: 開始處理 ${pending.length} 個項目`);

    await strategy.beforeProcess(pending);

    const results = {
      processed: 0,
      success: 0,
      failed: 0,
      errors: [],
    };

    // 分批處理
    for (let i = 0; i < pending.length; i += strategy.batchSize) {
      const batch = pending.slice(i, i + strategy.batchSize);

      for (const record of batch) {
        let attempts = 0;
        let success = false;

        while (attempts < strategy.retryCount && !success) {
          attempts++;

          try {
            const result = await strategy.processRecord(record, {
              checker: this.checker,
              updateRecord: this.updateRecord,
              dataDir: this.dataDir,
              ...this.context,
            });

            results.processed++;

            if (result.success) {
              results.success++;
              success = true;

              // 更新記錄
              if (result.updates) {
                this.updateRecord(record.id, result.updates);
              }

              this.emit('recordProcessed', strategy.name, record.id, result);
            } else {
              if (attempts >= strategy.retryCount) {
                results.failed++;
                results.errors.push({
                  id: record.id,
                  error: result.error || 'Unknown error',
                  attempts,
                });
              }
            }
          } catch (err) {
            if (attempts >= strategy.retryCount) {
              results.processed++;
              results.failed++;
              results.errors.push({
                id: record.id,
                error: err.message,
                attempts,
              });
            }
          }
        }

        // 任務間隔
        if (strategy.interval > 0) {
          await sleep(strategy.interval);
        }
      }

      // 批次間發出進度
      this.emit('batchComplete', strategy.name, {
        processed: results.processed,
        total: pending.length,
      });
    }

    await strategy.afterProcess(results);

    strategy.lastRun = Date.now();
    strategy.lastResult = {
      processed: results.processed,
      success: results.success,
      failed: results.failed,
    };

    console.log(
      `[Maintenance] ${strategy.name}: 完成 (成功: ${results.success}, 失敗: ${results.failed})`
    );

    return results;
  }

  /**
   * 記錄操作歷史
   */
  logHistory(action, results, duration) {
    const entry = {
      action,
      timestamp: new Date().toISOString(),
      duration,
      results,
    };

    this.history.unshift(entry);

    // 限制歷史記錄數量
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(0, this.maxHistorySize);
    }

    // 持久化歷史
    this.saveHistory();
  }

  /**
   * 儲存歷史記錄
   */
  saveHistory() {
    const historyPath = path.join(this.dataDir, 'maintenance-history.json');
    try {
      fs.writeFileSync(historyPath, JSON.stringify(this.history, null, 2));
    } catch (err) {
      console.error('[Maintenance] 儲存歷史失敗:', err.message);
    }
  }

  /**
   * 載入歷史記錄
   */
  loadHistory() {
    const historyPath = path.join(this.dataDir, 'maintenance-history.json');
    try {
      if (fs.existsSync(historyPath)) {
        this.history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      }
    } catch (err) {
      console.error('[Maintenance] 載入歷史失敗:', err.message);
      this.history = [];
    }
    return this.history;
  }

  /**
   * 取得歷史記錄
   */
  getHistory(limit = 20) {
    return this.history.slice(0, limit);
  }

  /**
   * 啟動自動排程
   */
  startAutoRun() {
    if (this.timer) {
      console.log('[Maintenance] 自動排程已在執行中');
      return;
    }

    this.config.autoRun = true;
    this.saveConfig();

    this.scheduleNextRun();

    console.log(
      `[Maintenance] 自動排程已啟動，間隔: ${this.config.runInterval / 1000}s`
    );
  }

  /**
   * 排程下次執行
   */
  scheduleNextRun() {
    this.nextRunTime = Date.now() + this.config.runInterval;

    this.timer = setTimeout(async () => {
      try {
        await this.runAll();
      } catch (err) {
        console.error('[Maintenance] 自動執行失敗:', err);
      }

      // 繼續排程
      if (this.config.autoRun) {
        this.scheduleNextRun();
      }
    }, this.config.runInterval);
  }

  /**
   * 停止自動排程
   */
  stopAutoRun() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextRunTime = null;
    }

    this.config.autoRun = false;
    this.saveConfig();

    console.log('[Maintenance] 自動排程已停止');
  }

  /**
   * 取得下次執行時間
   */
  getNextRunTime() {
    return this.nextRunTime;
  }

  /**
   * 清理資源
   */
  destroy() {
    this.stopAutoRun();
    this.removeAllListeners();
    this.strategies.clear();
  }
}

module.exports = MaintenanceScheduler;
