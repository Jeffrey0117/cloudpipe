/**
 * CLOUDPIPE - API Tunnel Service
 * 主程式入口
 */

const path = require('path');
const ServiceRegistry = require('./index');

// 專案根目錄
const rootDir = path.join(__dirname, '..', '..');

// 建立服務註冊中心
const registry = new ServiceRegistry();

// 載入設定
const configPath = path.join(rootDir, 'config.json');
registry.loadConfig(configPath);

console.log('');
console.log('========================================');
console.log('  CLOUDPIPE - API Tunnel Service');
console.log('========================================');
console.log('');

// 掃描排程器服務 (src/services/schedulers/*.js)
const schedulersDir = path.join(__dirname, 'schedulers');
registry.scanSchedulers(schedulersDir);

// 掃描獨立服務 (src/services/standalone/{name}/index.js)
const standaloneDir = path.join(__dirname, 'standalone');
registry.scanStandalone(standaloneDir);

// 從 config.json 載入額外的 standalone 服務
registry.loadStandaloneFromConfig(rootDir);

// 啟動所有服務
if (!registry.startAll()) {
  console.log('    Drop a .js file in src/services/schedulers/ directory');
  console.log('    Or create src/services/standalone/{name}/index.js');
  process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log('[*] Shutting down...');
  registry.stopAll();
  process.exit(0);
});

console.log('----------------------------------------');
console.log('Press Ctrl+C to stop all services');
console.log('----------------------------------------');
console.log('');

// Export for external use
module.exports = registry;
