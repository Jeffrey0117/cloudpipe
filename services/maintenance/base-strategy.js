/**
 * MaintenanceStrategy - 維護策略基礎類
 *
 * 所有具體策略都應繼承此類並實現 getPendingRecords 和 processRecord 方法
 */

class MaintenanceStrategy {
  /**
   * @param {string} name - 策略名稱
   * @param {object} options - 配置選項
   * @param {number} options.priority - 優先級 (1-10, 1 最高)
   * @param {number} options.batchSize - 批次處理數量
   * @param {number} options.interval - 任務間隔 (ms)
   * @param {boolean} options.enabled - 是否啟用
   * @param {number} options.retryCount - 重試次數
   */
  constructor(name, options = {}) {
    this.name = name;
    this.priority = options.priority ?? 5;
    this.batchSize = options.batchSize ?? 10;
    this.interval = options.interval ?? 0;
    this.enabled = options.enabled !== false;
    this.retryCount = options.retryCount ?? 3;
    this.lastRun = null;
    this.lastResult = null;
  }

  /**
   * 取得需要處理的記錄
   * @param {Array} records - 所有記錄
   * @param {RecordChecker} checker - 記錄檢查器
   * @returns {Array} 需要處理的記錄
   */
  async getPendingRecords(records, checker) {
    throw new Error('Subclass must implement getPendingRecords');
  }

  /**
   * 處理單筆記錄
   * @param {object} record - 記錄
   * @param {object} context - 執行上下文 (包含 checker, db, helpers 等)
   * @returns {object} { success: boolean, updates?: object, error?: string }
   */
  async processRecord(record, context) {
    throw new Error('Subclass must implement processRecord');
  }

  /**
   * 處理前回調
   * @param {Array} records - 待處理記錄
   */
  async beforeProcess(records) {
    // 子類可覆寫
  }

  /**
   * 處理後回調
   * @param {object} results - 處理結果
   */
  async afterProcess(results) {
    // 子類可覆寫
  }

  /**
   * 更新策略配置
   * @param {object} config - 新配置
   */
  updateConfig(config) {
    if (config.priority !== undefined) this.priority = config.priority;
    if (config.batchSize !== undefined) this.batchSize = config.batchSize;
    if (config.interval !== undefined) this.interval = config.interval;
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.retryCount !== undefined) this.retryCount = config.retryCount;
  }

  /**
   * 取得策略狀態
   */
  getStatus() {
    return {
      name: this.name,
      priority: this.priority,
      batchSize: this.batchSize,
      interval: this.interval,
      enabled: this.enabled,
      retryCount: this.retryCount,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
    };
  }
}

module.exports = MaintenanceStrategy;
