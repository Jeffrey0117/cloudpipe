/**
 * CLOUDPIPE - API Tunnel Service
 * 主程式入口
 */

const path = require('path');
const ServiceRegistry = require('./registry');
const deploy = require('./deploy');

// 專案根目錄
const rootDir = path.join(__dirname, '..', '..');

// 建立服務註冊中心
const registry = new ServiceRegistry();

// 載入設定
const configPath = path.join(rootDir, 'config.json');
registry.loadConfig(configPath);

console.log('');
console.log('========================================');
console.log('  CLOUDPIPE - Local Deploy Gateway');
console.log('========================================');
console.log('');

// 掃描服務 (services/*.js)
const servicesDir = path.join(rootDir, 'services');
registry.scanServices(servicesDir);

// 啟動所有服務
if (!registry.startAll()) {
  console.log('    Drop a .js file in services/ directory');
  process.exit(1);
}

// 啟動 GitHub 輪詢（Backup 機制，每 5 分鐘）
deploy.startPolling(5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log('[*] Shutting down...');
  deploy.stopPolling();
  registry.stopAll();
  process.exit(0);
});

console.log('----------------------------------------');
console.log('Press Ctrl+C to stop all services');
console.log('----------------------------------------');
console.log('');

// Export for external use
module.exports = registry;
