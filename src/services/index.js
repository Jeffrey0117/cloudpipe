/**
 * 服務註冊中心
 * 統一管理所有服務的生命週期
 */

const fs = require('fs');
const path = require('path');

class ServiceRegistry {
  constructor() {
    this.services = [];
    this.servers = [];
    this.config = null;
  }

  /**
   * 載入設定
   */
  loadConfig(configPath) {
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return this.config;
  }

  /**
   * 掃描並註冊排程器服務
   * schedulers/ 目錄下的 .js 檔案
   */
  scanSchedulers(dir) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    files.forEach(file => {
      this.services.push({
        name: path.basename(file, '.js'),
        entry: path.join(dir, file),
        port: this.config.port,
        subdomain: this.config.subdomain,
        type: 'scheduler'
      });
    });
  }

  /**
   * 掃描並註冊獨立服務
   * standalone/{name}/index.js
   */
  scanStandalone(dir) {
    if (!fs.existsSync(dir)) return;

    const dirs = fs.readdirSync(dir).filter(d => {
      const fullPath = path.join(dir, d);
      return fs.statSync(fullPath).isDirectory();
    });

    dirs.forEach(d => {
      const indexPath = path.join(dir, d, 'index.js');
      const configPath = path.join(dir, d, 'config.json');

      if (fs.existsSync(indexPath)) {
        // 讀取服務自己的 config（如果有）
        let serviceConfig = {};
        if (fs.existsSync(configPath)) {
          serviceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        this.services.push({
          name: d,
          entry: indexPath,
          port: serviceConfig.port || this.config.port + this.services.length,
          subdomain: serviceConfig.subdomain || d,
          type: 'standalone',
          config: serviceConfig
        });
      }
    });
  }

  /**
   * 從 config.json 的 standalone 陣列註冊
   */
  loadStandaloneFromConfig(baseDir) {
    if (!this.config.standalone || this.config.standalone.length === 0) return;

    this.config.standalone.forEach(s => {
      this.services.push({
        name: s.name,
        entry: path.join(baseDir, s.entry),
        port: s.port,
        subdomain: s.subdomain,
        type: 'standalone'
      });
    });
  }

  /**
   * 取得所有服務
   */
  getServices() {
    return this.services;
  }

  /**
   * 啟動所有服務
   */
  startAll() {
    if (this.services.length === 0) {
      console.log('[!] No services found');
      return false;
    }

    console.log(`[*] Starting ${this.services.length} service(s)...`);
    console.log('');

    this.services.forEach(service => {
      try {
        if (!fs.existsSync(service.entry)) {
          console.log(`[!] ${service.name}: Entry file not found: ${service.entry}`);
          return;
        }

        const createServer = require(service.entry);
        const server = createServer(service);

        server.listen(service.port, () => {
          console.log(`[OK] ${service.name}`);
          console.log(`     Type: ${service.type}`);
          console.log(`     Port: ${service.port}`);
          if (this.config.domain) {
            console.log(`     URL:  https://${service.subdomain}.${this.config.domain}`);
          }
          console.log('');
        });

        this.servers.push({ service, server });
      } catch (err) {
        console.log(`[!] ${service.name}: Failed to start - ${err.message}`);
      }
    });

    return true;
  }

  /**
   * 停止所有服務
   */
  stopAll() {
    this.servers.forEach(({ service, server }) => {
      server.close();
      console.log(`[OK] ${service.name} stopped`);
    });
  }

  /**
   * 取得服務狀態
   */
  getStatus() {
    return {
      total: this.services.length,
      running: this.servers.length,
      services: this.services.map(s => ({
        name: s.name,
        type: s.type,
        port: s.port,
        subdomain: s.subdomain
      }))
    };
  }
}

module.exports = ServiceRegistry;
