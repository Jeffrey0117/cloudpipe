/**
 * 管理 API - CloudPipe Dashboard 後端
 * 路徑：/api/_admin/*
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 目錄路徑
const ROOT = path.join(__dirname, '..', '..');
const SERVICES_DIR = path.join(ROOT, 'services');
const APPS_DIR = path.join(ROOT, 'apps');

// Cloudflared 路徑
const CLOUDFLARED = 'C:\\Users\\jeffb\\cloudflared.exe';
const TUNNEL_ID = 'afd11345-c75a-4d62-aa67-0a389d82ce74';

// 確保 apps 目錄存在
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

module.exports = {
  match(req) {
    return req.url.startsWith('/api/_admin');
  },

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // GET /api/_admin/services - 列出所有服務
    if (req.method === 'GET' && pathname === '/api/_admin/services') {
      return listServices(req, res);
    }

    // POST /api/_admin/upload/service - 上傳 API 服務
    if (req.method === 'POST' && pathname === '/api/_admin/upload/service') {
      return uploadService(req, res);
    }

    // POST /api/_admin/upload/app - 上傳專案
    if (req.method === 'POST' && pathname === '/api/_admin/upload/app') {
      return uploadApp(req, res);
    }

    // DELETE /api/_admin/service/:name
    if (req.method === 'DELETE' && pathname.startsWith('/api/_admin/service/')) {
      const name = pathname.split('/').pop();
      return deleteService(name, res);
    }

    // DELETE /api/_admin/app/:name
    if (req.method === 'DELETE' && pathname.startsWith('/api/_admin/app/')) {
      const name = pathname.split('/').pop();
      return deleteApp(name, res);
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};

// 列出所有服務和專案
function listServices(req, res) {
  const services = [];
  const apps = [];

  // 掃描 services/
  if (fs.existsSync(SERVICES_DIR)) {
    fs.readdirSync(SERVICES_DIR)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .forEach(file => {
        const name = path.basename(file, '.js');
        services.push({
          name,
          url: `https://epi.isnowfriend.com/${name}`,
          status: 'running'
        });
      });
  }

  // 掃描 apps/
  if (fs.existsSync(APPS_DIR)) {
    fs.readdirSync(APPS_DIR)
      .filter(d => fs.statSync(path.join(APPS_DIR, d)).isDirectory())
      .forEach(dir => {
        apps.push({
          name: dir,
          url: `https://${dir}.isnowfriend.com`,
          status: 'running'
        });
      });
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ services, apps }));
}

// 上傳 API 服務
function uploadService(req, res) {
  parseMultipart(req, (err, fields, files) => {
    if (err || !files.file) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '上傳失敗' }));
    }

    const file = files.file;
    if (!file.filename.endsWith('.js')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '只接受 .js 檔案' }));
    }

    // 使用用戶給的名稱
    const name = fields.name;
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '無效的名稱' }));
    }

    // 檢查是否已存在
    const destPath = path.join(SERVICES_DIR, `${name}.js`);
    if (fs.existsSync(destPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '名稱已被使用' }));
    }

    fs.writeFileSync(destPath, file.data);
    console.log(`[admin] 服務已建立: ${name}`);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      name,
      url: `https://epi.isnowfriend.com/${name}`
    }));
  });
}

// 上傳專案
function uploadApp(req, res) {
  parseMultipart(req, (err, fields, files) => {
    if (err || !files.file) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '上傳失敗' }));
    }

    const name = fields.name;
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '無效的子域名' }));
    }

    const appDir = path.join(APPS_DIR, name);

    // 檢查是否已存在
    if (fs.existsSync(appDir)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '名稱已被使用' }));
    }

    // 建立目錄
    fs.mkdirSync(appDir, { recursive: true });

    // 儲存 zip
    const zipPath = path.join(appDir, 'upload.zip');
    fs.writeFileSync(zipPath, files.file.data);

    // 解壓 zip
    try {
      execSync(`tar -xf "${zipPath}" -C "${appDir}"`, { stdio: 'ignore' });
      fs.unlinkSync(zipPath); // 刪除 zip
    } catch (e) {
      console.error('[admin] 解壓失敗:', e.message);
    }

    // 自動建立 DNS CNAME
    try {
      const hostname = `${name}.isnowfriend.com`;
      execSync(`"${CLOUDFLARED}" tunnel route dns ${TUNNEL_ID} ${hostname}`, { stdio: 'ignore' });
      console.log(`[admin] DNS 已建立: ${hostname}`);
    } catch (e) {
      console.error('[admin] DNS 建立失敗:', e.message);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      name,
      url: `https://${name}.isnowfriend.com`
    }));
  });
}

// 刪除服務
function deleteService(name, res) {
  const filePath = path.join(SERVICES_DIR, `${name}.js`);
  
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '服務不存在' }));
  }

  fs.unlinkSync(filePath);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

// 刪除專案
function deleteApp(name, res) {
  const appDir = path.join(APPS_DIR, name);
  
  if (!fs.existsSync(appDir)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '專案不存在' }));
  }

  fs.rmSync(appDir, { recursive: true });

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

// 簡易 multipart parser
function parseMultipart(req, callback) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.split('boundary=')[1];
  
  if (!boundary) {
    return callback(new Error('No boundary'));
  }

  let body = Buffer.alloc(0);
  
  req.on('data', chunk => {
    body = Buffer.concat([body, chunk]);
  });

  req.on('end', () => {
    try {
      const fields = {};
      const files = {};
      
      const parts = body.toString('binary').split('--' + boundary);
      
      parts.forEach(part => {
        if (part.includes('Content-Disposition')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          const header = part.substring(0, headerEnd);
          const content = part.substring(headerEnd + 4).replace(/\r\n--$/, '').replace(/\r\n$/, '');
          
          const nameMatch = header.match(/name="([^"]+)"/);
          const filenameMatch = header.match(/filename="([^"]+)"/);
          
          if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
              files[name] = {
                filename: filenameMatch[1],
                data: Buffer.from(content, 'binary')
              };
            } else {
              fields[name] = content;
            }
          }
        }
      });
      
      callback(null, fields, files);
    } catch (err) {
      callback(err);
    }
  });
}
