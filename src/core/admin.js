/**
 * 管理 API - CloudPipe Dashboard 後端
 * 路徑：/api/_admin/*
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const hotloader = require('./hotloader');
const deploy = require('./deploy');

// 目錄路徑
const ROOT = path.join(__dirname, '..', '..');
const SERVICES_DIR = path.join(ROOT, 'services');
const APPS_DIR = path.join(ROOT, 'apps');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// Cloudflared 路徑
const CLOUDFLARED = 'C:\\Users\\jeffb\\cloudflared.exe';
const TUNNEL_ID = 'afd11345-c75a-4d62-aa67-0a389d82ce74';

// 讀取密碼
function getPassword() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return config.adminPassword || '';
  } catch {
    return '';
  }
}

// 簡易 token (SHA256 hash of password + secret)
const TOKEN_SECRET = 'cloudpipe_2024';
function generateToken(password) {
  return crypto.createHash('sha256').update(password + TOKEN_SECRET).digest('hex');
}

function verifyToken(token) {
  const expectedToken = generateToken(getPassword());
  return token === expectedToken;
}

// 驗證 middleware
function requireAuth(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  return verifyToken(token);
}

// 確保 apps 目錄存在
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

module.exports = {
  match(req) {
    return req.url.startsWith('/api/_admin') || req.url.startsWith('/webhook/');
  },

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // ===== Webhook（不需要驗證，但會驗證 secret）=====
    if (req.method === 'POST' && pathname.startsWith('/webhook/')) {
      return handleWebhook(req, res, pathname);
    }

    // POST /api/_admin/login - 登入
    if (req.method === 'POST' && pathname === '/api/_admin/login') {
      return handleLogin(req, res);
    }

    // GET /api/_admin/verify - 驗證 token
    if (req.method === 'GET' && pathname === '/api/_admin/verify') {
      if (requireAuth(req)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ valid: true }));
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // ===== 以下需要驗證 =====
    if (!requireAuth(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // ===== 部署 API =====

    // GET /api/_admin/deploy/projects - 列出所有專案
    if (req.method === 'GET' && pathname === '/api/_admin/deploy/projects') {
      const projects = deploy.getAllProjects();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ projects }));
    }

    // POST /api/_admin/deploy/projects - 新增專案
    if (req.method === 'POST' && pathname === '/api/_admin/deploy/projects') {
      return handleCreateProject(req, res);
    }

    // GET /api/_admin/deploy/projects/:id - 專案詳情
    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      const project = deploy.getProject(id);
      if (!project) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '專案不存在' }));
      }
      const deployments = deploy.getDeployments(id, 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ project, deployments }));
    }

    // PUT /api/_admin/deploy/projects/:id - 更新專案
    if (req.method === 'PUT' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      return handleUpdateProject(req, res, id);
    }

    // DELETE /api/_admin/deploy/projects/:id - 刪除專案
    if (req.method === 'DELETE' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      try {
        deploy.deleteProject(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/_admin/deploy/projects/:id/deploy - 手動觸發部署
    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/deploy$/)) {
      const id = pathname.split('/')[5];
      return handleManualDeploy(req, res, id);
    }

    // POST /api/_admin/deploy/projects/:id/webhook - 設定 GitHub Webhook
    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhook$/)) {
      const id = pathname.split('/')[5];
      return handleSetupWebhook(req, res, id);
    }

    // DELETE /api/_admin/deploy/projects/:id/webhook - 刪除 GitHub Webhook
    if (req.method === 'DELETE' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhook$/)) {
      const id = pathname.split('/')[5];
      return handleRemoveWebhook(req, res, id);
    }

    // GET /api/_admin/deploy/projects/:id/webhooks - 列出 GitHub Webhooks
    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhooks$/)) {
      const id = pathname.split('/')[5];
      return handleListWebhooks(req, res, id);
    }

    // GET /api/_admin/deploy/logs/:pm2Name - 取得 PM2 log
    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/logs\/[^/]+$/)) {
      const pm2Name = pathname.split('/').pop();
      return handleGetPM2Logs(req, res, pm2Name);
    }

    // GET /api/_admin/deploy/deployments - 所有部署記錄
    if (req.method === 'GET' && pathname === '/api/_admin/deploy/deployments') {
      const deployments = deploy.getDeployments(null, 50);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ deployments }));
    }

    // GET /api/_admin/deploy/deployments/:id - 部署詳情
    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/deployments\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      const deployment = deploy.getDeployment(id);
      if (!deployment) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '部署記錄不存在' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ deployment }));
    }

    // ===== 原有 API =====

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

    // GET /api/_admin/system - 系統資訊
    if (req.method === 'GET' && pathname === '/api/_admin/system') {
      return handleSystemInfo(req, res);
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};

// 登入處理
function handleLogin(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { password } = JSON.parse(body);
      const correctPassword = getPassword();

      if (password === correctPassword) {
        const token = generateToken(password);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, token }));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '密碼錯誤' }));
      }
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  });
}

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

    // 熱載入：立即載入新服務
    hotloader.loadService(destPath);

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

  // 熱卸載：從記憶體移除
  hotloader.unloadService(name);

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

// ===== 部署相關處理函數 =====

// 解析 JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// 新增專案
async function handleCreateProject(req, res) {
  try {
    const data = await parseJsonBody(req);
    const project = deploy.createProject(data);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, project }));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 更新專案
async function handleUpdateProject(req, res, id) {
  try {
    const data = await parseJsonBody(req);
    const project = deploy.updateProject(id, data);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, project }));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 手動觸發部署
async function handleManualDeploy(req, res, id) {
  try {
    console.log(`[deploy] 手動觸發部署: ${id}`);

    // 立即回應，部署在背景執行
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: '部署已觸發' }));

    // 背景執行部署
    deploy.deploy(id, { triggeredBy: 'manual' }).catch(err => {
      console.error(`[deploy] 部署失敗: ${err.message}`);
    });
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 設定 GitHub Webhook
async function handleSetupWebhook(req, res, id) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const { webhookUrl } = JSON.parse(body);
      if (!webhookUrl) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '缺少 webhookUrl' }));
      }

      const result = await deploy.setupGitHubWebhook(id, webhookUrl);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// 刪除 GitHub Webhook
async function handleRemoveWebhook(req, res, id) {
  try {
    const result = await deploy.removeGitHubWebhook(id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 列出 GitHub Webhooks
function handleListWebhooks(req, res, id) {
  try {
    const webhooks = deploy.listGitHubWebhooks(id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ webhooks }));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 取得 PM2 Log
function handleGetPM2Logs(req, res, pm2Name) {
  try {
    // 讀取 PM2 log 檔案
    const pm2LogPath = path.join(process.env.USERPROFILE || process.env.HOME, '.pm2', 'logs');
    const outLogPath = path.join(pm2LogPath, `${pm2Name}-out.log`);
    const errLogPath = path.join(pm2LogPath, `${pm2Name}-error.log`);

    let logs = '';

    // 讀取最後 100 行 out log
    if (fs.existsSync(outLogPath)) {
      const content = fs.readFileSync(outLogPath, 'utf8');
      const lines = content.split('\n').slice(-100).join('\n');
      logs += '=== stdout ===\n' + lines + '\n\n';
    }

    // 讀取最後 50 行 error log
    if (fs.existsSync(errLogPath)) {
      const content = fs.readFileSync(errLogPath, 'utf8');
      const lines = content.split('\n').slice(-50).join('\n');
      if (lines.trim()) {
        logs += '=== stderr ===\n' + lines;
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ logs: logs || '無 log 檔案' }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 系統資訊
async function handleSystemInfo(req, res) {
  try {
    const os = require('os');

    // 取得 lurl 資料目錄大小和記錄數
    // lurl.js 的 DATA_DIR = path.join(__dirname, '..', 'data', 'lurl')
    // 也就是 cloudpipe/data/lurl/
    const DATA_DIR = path.join(ROOT, 'data', 'lurl');
    const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');

    let totalRecords = 0;
    let totalVideos = 0;
    let totalImages = 0;
    let diskUsed = '0 MB';

    // 讀取 lurl 資料庫統計（JSONL 格式，每行一個 JSON）
    if (fs.existsSync(RECORDS_FILE)) {
      try {
        const content = fs.readFileSync(RECORDS_FILE, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());
        const records = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(r => r);
        totalRecords = records.length;
        totalVideos = records.filter(r => r.type === 'video').length;
        totalImages = records.filter(r => r.type === 'image').length;
      } catch (e) {
        console.error('[admin] 讀取 lurl records 失敗:', e.message);
      }
    }

    // 計算資料目錄大小
    if (fs.existsSync(DATA_DIR)) {
      try {
        const size = getDirSize(DATA_DIR);
        if (size > 1024 * 1024 * 1024) {
          diskUsed = (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        } else {
          diskUsed = (size / 1024 / 1024).toFixed(2) + ' MB';
        }
      } catch (e) {
        console.error('[admin] 計算目錄大小失敗:', e.message);
      }
    }

    // 系統總磁碟空間（粗略估計）
    const diskTotal = '50 GB'; // VPS 預設值

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      disk: {
        used: diskUsed,
        total: diskTotal
      },
      totalRecords,
      totalVideos,
      totalImages,
      uptime: process.uptime()
    }));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// 計算目錄大小
function getDirSize(dirPath) {
  let size = 0;
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += stat.size;
      }
    }
  } catch (e) {
    // 忽略無法讀取的目錄
  }
  return size;
}

// Webhook Log 檔案路徑
const WEBHOOK_LOG_FILE = path.join(__dirname, '../../data/deploy/webhook-logs.json');

// 記錄 Webhook 接收
function logWebhook(projectId, event, data = {}) {
  const log = {
    id: `wh_${Date.now().toString(36)}`,
    projectId,
    event,
    timestamp: new Date().toISOString(),
    ...data
  };

  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')).logs || [];
  } catch (e) {}

  logs.unshift(log);
  // 只保留最近 100 筆
  logs = logs.slice(0, 100);

  fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify({ logs }, null, 2));
  console.log(`[webhook] ${event}: ${projectId}`, data.commit || data.reason || '');
}

// GitHub Webhook 處理
async function handleWebhook(req, res, pathname) {
  // 從路徑取得專案 ID: /webhook/:projectId
  const projectId = pathname.replace('/webhook/', '');
  const receivedAt = new Date().toISOString();

  const project = deploy.getProject(projectId);
  if (!project) {
    logWebhook(projectId, 'rejected', { reason: '專案不存在' });
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '專案不存在' }));
  }

  // 收集 body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      // 驗證 GitHub signature（如果有設定 secret）
      if (project.webhookSecret) {
        const signature = req.headers['x-hub-signature-256'];
        if (!deploy.verifyGitHubWebhook(body, signature, project.webhookSecret)) {
          logWebhook(projectId, 'rejected', { reason: '簽名驗證失敗' });
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid signature' }));
        }
      }

      const payload = JSON.parse(body);

      // 檢查是否為正確的 branch
      const ref = payload.ref || '';
      const branch = ref.replace('refs/heads/', '');
      const commit = payload.after ? payload.after.substring(0, 7) : null;
      const commitMessage = payload.head_commit?.message || '';

      if (branch !== project.branch) {
        logWebhook(projectId, 'ignored', { reason: `非目標 branch: ${branch}`, branch });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ignored: true, reason: 'Wrong branch' }));
      }

      // 記錄成功接收
      logWebhook(projectId, 'received', { branch, commit, commitMessage: commitMessage.substring(0, 50) });

      // 回應 GitHub
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '部署已觸發' }));

      // 背景執行部署
      deploy.deploy(projectId, { triggeredBy: 'webhook' }).catch(err => {
        console.error(`[webhook] 部署失敗: ${err.message}`);
      });

    } catch (err) {
      logWebhook(projectId, 'error', { reason: err.message });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}
