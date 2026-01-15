/**
 * 核心路由器
 * 載入 services/ 下所有 .js 檔案作為路由
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('./admin');

module.exports = function(config) {
  const routes = [];
  const dir = config.servicesDir;

  // 掃描 services/ 目錄，載入所有 .js（底線開頭除外）
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .forEach(file => {
        try {
          const route = require(path.join(dir, file));
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

    console.log(`[${config.name}] ${req.method} ${req.url}`);

    // 靜態檔案 MIME types
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    // 靜態檔案服務 (public/)
    const publicDir = path.join(dir, '..', 'public');
    const urlPath = req.url.split('?')[0];
    const staticFile = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.join(publicDir, staticFile);
    const ext = path.extname(filePath);

    if (ext && mimeTypes[ext] && fs.existsSync(filePath)) {
      res.writeHead(200, { 'content-type': mimeTypes[ext] });
      return res.end(fs.readFileSync(filePath));
    }

    // Admin API
    if (admin.match(req)) {
      return admin.handle(req, res);
    }

    // Health check API
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        service: config.name,
        routes: routes.map(r => r.name),
        timestamp: new Date().toISOString()
      }));
    }

    // 嘗試匹配路由
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
  });
};
