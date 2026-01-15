/**
 * 核心路由器
 * 支援兩種模式：
 * 1. epi.isnowfriend.com → Dashboard + services/
 * 2. xxx.isnowfriend.com → apps/xxx/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('./admin');

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

module.exports = function(config) {
  const servicesDir = config.servicesDir;
  const rootDir = path.join(servicesDir, '..');
  const publicDir = path.join(rootDir, 'public');
  const appsDir = path.join(rootDir, 'apps');
  const mainSubdomain = config.subdomain || 'epi';

  // 確保 apps 目錄存在
  if (!fs.existsSync(appsDir)) {
    fs.mkdirSync(appsDir, { recursive: true });
  }

  // 載入 services/
  const routes = [];
  if (fs.existsSync(servicesDir)) {
    fs.readdirSync(servicesDir)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .forEach(file => {
        try {
          const route = require(path.join(servicesDir, file));
          if (typeof route === 'function' || typeof route === 'object') {
            routes.push({ name: path.basename(file, '.js'), handler: route });
            console.log(`[${config.name}] 載入服務: ${file}`);
          }
        } catch (err) {
          console.error(`[${config.name}] 載入失敗: ${file} - ${err.message}`);
        }
      });
  }

  return http.createServer((req, res) => {
    // CORS
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 解析 hostname
    const host = req.headers.host || '';
    const hostname = host.split(':')[0];
    const subdomain = hostname.split('.')[0];

    console.log(`[${subdomain}] ${req.method} ${req.url}`);

    // ========== 主域名 (epi.isnowfriend.com) ==========
    if (subdomain === mainSubdomain || hostname === 'localhost') {
      return handleMainDomain(req, res, { publicDir, routes });
    }

    // ========== 子域名 (xxx.isnowfriend.com) ==========
    return handleAppDomain(req, res, { subdomain, appsDir });
  });

  // 處理主域名
  function handleMainDomain(req, res, { publicDir, routes }) {
    const urlPath = req.url.split('?')[0];

    // 靜態檔案 (public/)
    const staticFile = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(publicDir, staticFile);
    const ext = path.extname(filePath);

    if (ext && MIME[ext] && fs.existsSync(filePath)) {
      res.writeHead(200, { 'content-type': MIME[ext] });
      return res.end(fs.readFileSync(filePath));
    }

    // Admin API
    if (admin.match(req)) {
      return admin.handle(req, res);
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        routes: routes.map(r => r.name),
        timestamp: new Date().toISOString()
      }));
    }

    // Services 路由
    for (const route of routes) {
      if (typeof route.handler === 'function') {
        const handled = route.handler(req, res);
        if (handled) return;
      } else if (route.handler.match && route.handler.handle) {
        if (route.handler.match(req)) {
          return route.handler.handle(req, res);
        }
      }
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // 處理 App 子域名
  function handleAppDomain(req, res, { subdomain, appsDir }) {
    const appDir = path.join(appsDir, subdomain);

    // 檢查 app 是否存在
    if (!fs.existsSync(appDir)) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<h1>App not found: ${subdomain}</h1>`);
    }

    const urlPath = req.url.split('?')[0];

    // 檢查是否有 server.js (後端應用)
    const serverPath = path.join(appDir, 'server.js');
    if (fs.existsSync(serverPath)) {
      try {
        const appHandler = require(serverPath);
        if (typeof appHandler === 'function') {
          return appHandler(req, res);
        } else if (appHandler.handle) {
          return appHandler.handle(req, res);
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 靜態檔案服務 (public/ 或根目錄)
    const appPublicDir = fs.existsSync(path.join(appDir, 'public'))
      ? path.join(appDir, 'public')
      : appDir;

    const staticFile = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(appPublicDir, staticFile);
    const ext = path.extname(filePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      return res.end(fs.readFileSync(filePath));
    }

    // SPA fallback - 嘗試返回 index.html
    const indexPath = path.join(appPublicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(indexPath));
    }

    // 404
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>File not found: ${urlPath}</h1>`);
  }
};
