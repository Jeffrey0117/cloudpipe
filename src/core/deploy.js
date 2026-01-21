/**
 * Cloudpipe 部署引擎
 *
 * 功能：
 * - 專案管理 (CRUD)
 * - Git 部署 (pull + pm2 reload)
 * - 上傳部署 (解壓 ZIP)
 * - 部署記錄
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data/deploy');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const DEPLOYMENTS_FILE = path.join(DATA_DIR, 'deployments.json');
const CLOUDPIPE_ROOT = path.join(__dirname, '../..');

// Cloudflare Tunnel 設定
const CLOUDFLARED = 'C:\\Users\\jeffb\\cloudflared.exe';
const TUNNEL_ID = 'afd11345-c75a-4d62-aa67-0a389d82ce74';
const CLOUDFLARED_CONFIG = path.join(__dirname, '../../cloudflared.yml');

// Port 分配設定
const BASE_PORT = 4000;  // 起始 port

// ==================== 資料存取 ====================

function readProjects() {
  try {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects || [];
  } catch {
    return [];
  }
}

function writeProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2));
}

function readDeployments() {
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf8')).deployments || [];
  } catch {
    return [];
  }
}

function writeDeployments(deployments) {
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify({ deployments }, null, 2));
}

// 取得下一個可用 port
function getNextAvailablePort() {
  const projects = readProjects();
  const usedPorts = projects
    .filter(p => p.port)
    .map(p => p.port);

  if (usedPorts.length === 0) {
    return BASE_PORT + 1;  // 4001
  }

  return Math.max(...usedPorts) + 1;
}

// ==================== 專案管理 ====================

function getProject(id) {
  return readProjects().find(p => p.id === id);
}

function getAllProjects() {
  return readProjects();
}

function createProject(data) {
  const projects = readProjects();

  // 檢查 ID 是否已存在
  if (projects.find(p => p.id === data.id)) {
    throw new Error(`專案 ID "${data.id}" 已存在`);
  }

  // Git 部署的專案自動分配 port
  const deployMethod = data.deployMethod || 'manual';
  const isGitDeploy = deployMethod === 'github' || deployMethod === 'git-url';
  const autoPort = isGitDeploy ? getNextAvailablePort() : null;

  const project = {
    id: data.id,
    name: data.name || data.id,
    description: data.description || '',
    deployMethod,
    repoUrl: data.repoUrl || '',
    branch: data.branch || 'main',
    directory: data.directory || `projects/${data.id}`,
    entryFile: data.entryFile || 'index.js',
    port: data.port || autoPort,  // 自動分配或手動指定
    pm2Name: data.pm2Name || data.id,
    webhookSecret: data.webhookSecret || crypto.randomBytes(20).toString('hex'),
    envFile: data.envFile || '',
    buildCommand: data.buildCommand || '',
    createdAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null
  };

  projects.push(project);
  writeProjects(projects);

  return project;
}

function updateProject(id, data) {
  const projects = readProjects();
  const index = projects.findIndex(p => p.id === id);

  if (index === -1) {
    throw new Error(`專案 "${id}" 不存在`);
  }

  // 不允許修改 id 和 createdAt
  const { id: _, createdAt: __, ...updateData } = data;
  projects[index] = { ...projects[index], ...updateData };
  writeProjects(projects);

  return projects[index];
}

function deleteProject(id) {
  const projects = readProjects();
  const filtered = projects.filter(p => p.id !== id);

  if (filtered.length === projects.length) {
    throw new Error(`專案 "${id}" 不存在`);
  }

  writeProjects(filtered);
  return true;
}

// ==================== Cloudflare Tunnel Ingress ====================

/**
 * 更新 cloudflared.yml，加入專案的 ingress 規則
 */
function updateTunnelIngress(hostname, port) {
  try {
    if (!fs.existsSync(CLOUDFLARED_CONFIG)) {
      console.log(`[deploy] cloudflared.yml 不存在，跳過 ingress 更新`);
      return false;
    }

    let content = fs.readFileSync(CLOUDFLARED_CONFIG, 'utf8');

    // 檢查是否已存在此 hostname
    if (content.includes(`hostname: ${hostname}`)) {
      console.log(`[deploy] Ingress 已存在: ${hostname}`);
      return true;
    }

    // 在 "*.isnowfriend.com" 之前插入新規則
    const wildcardPattern = /(\s*- hostname: "\*\.isnowfriend\.com")/;
    const newRule = `  - hostname: ${hostname}\n    service: http://localhost:${port}\n`;

    if (wildcardPattern.test(content)) {
      content = content.replace(wildcardPattern, newRule + '$1');
    } else {
      // 如果沒有通配符規則，在最後一個 service: http_status:404 之前插入
      const fallbackPattern = /(\s*- service: http_status:404)/;
      content = content.replace(fallbackPattern, newRule + '$1');
    }

    fs.writeFileSync(CLOUDFLARED_CONFIG, content);
    console.log(`[deploy] Ingress 已新增: ${hostname} -> localhost:${port}`);

    // 重啟 tunnel
    try {
      execSync('pm2 restart tunnel', { stdio: 'pipe' });
      console.log(`[deploy] Tunnel 已重啟`);
    } catch (e) {
      console.log(`[deploy] Tunnel 重啟失敗: ${e.message}`);
    }

    return true;
  } catch (e) {
    console.error(`[deploy] 更新 ingress 失敗:`, e.message);
    return false;
  }
}

// ==================== Health Check ====================

/**
 * 執行 Health Check，確認服務啟動
 * @param {number} port - 服務 port
 * @param {string} endpoint - 檢查的 endpoint（預設 /health）
 * @param {function} log - log 函數
 * @param {number} retries - 重試次數（預設 3）
 * @param {number} delay - 重試間隔 ms（預設 2000）
 */
async function performHealthCheck(port, endpoint = '/health', log, retries = 5, delay = 3000) {
  const http = require('http');
  const url = `http://localhost:${port}${endpoint}`;

  for (let i = 0; i < retries; i++) {
    // 等待服務啟動
    await new Promise(r => setTimeout(r, delay));

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (res) => {
          // 2xx 或 3xx 都算成功
          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve(true);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });

      if (result) return true;
    } catch (e) {
      log(`Health Check 嘗試 ${i + 1}/${retries} 失敗: ${e.message}`);
    }
  }

  return false;
}

// ==================== 部署引擎 ====================

function generateDeployId() {
  return 'deploy_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

async function deploy(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  const deployId = generateDeployId();
  const startedAt = new Date().toISOString();
  const logs = [];

  const log = (msg) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${msg}`);
    console.log(`[deploy:${projectId}] ${msg}`);
  };

  // 建立部署記錄
  const deployment = {
    id: deployId,
    projectId,
    status: 'building',
    commit: null,
    commitMessage: null,
    branch: project.branch,
    startedAt,
    finishedAt: null,
    duration: null,
    logs: [],
    triggeredBy: options.triggeredBy || 'manual',
    error: null
  };

  const deployments = readDeployments();
  deployments.unshift(deployment);
  writeDeployments(deployments);

  try {
    const projectDir = path.join(CLOUDPIPE_ROOT, project.directory);

    log(`開始部署專案: ${project.name}`);
    log(`專案目錄: ${projectDir}`);

    // 確保目錄存在
    if (!fs.existsSync(projectDir)) {
      if (project.deployMethod === 'github' || project.deployMethod === 'git-url') {
        // Clone repo（不指定 branch，自動用 repo 預設 branch）
        log(`目錄不存在，執行 git clone...`);
        const parentDir = path.dirname(projectDir);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        execSync(`git clone ${project.repoUrl} ${path.basename(projectDir)}`, {
          cwd: parentDir,
          stdio: 'pipe'
        });
        // 自動偵測實際使用的 branch 並更新配置
        const actualBranch = execSync('git branch --show-current', { cwd: projectDir }).toString().trim();
        if (actualBranch && actualBranch !== project.branch) {
          log(`偵測到預設 branch: ${actualBranch}（原設定: ${project.branch}）`);
          updateProject(project.id, { branch: actualBranch });
          project.branch = actualBranch;
        }
        log(`Clone 完成 (branch: ${project.branch})`);
      } else {
        fs.mkdirSync(projectDir, { recursive: true });
        log(`建立目錄: ${projectDir}`);
      }
    }

    // Git 部署
    if (project.deployMethod === 'github' || project.deployMethod === 'git-url') {
      log(`執行 git fetch...`);
      execSync(`git fetch origin ${project.branch}`, { cwd: projectDir, stdio: 'pipe' });

      log(`執行 git reset --hard...`);
      execSync(`git reset --hard origin/${project.branch}`, { cwd: projectDir, stdio: 'pipe' });

      // 取得 commit 資訊
      const commitHash = execSync('git rev-parse --short HEAD', { cwd: projectDir }).toString().trim();
      const commitMessage = execSync('git log -1 --pretty=%B', { cwd: projectDir }).toString().trim();

      deployment.commit = commitHash;
      deployment.commitMessage = commitMessage;
      log(`Commit: ${commitHash} - ${commitMessage}`);
    }

    // 自動安裝依賴（如果有 package.json）
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const nodeModulesPath = path.join(projectDir, 'node_modules');
      const lockPath = path.join(projectDir, 'package-lock.json');
      const hashFile = path.join(projectDir, '.pkg-hash');

      // 計算 package.json + lock 的 hash
      const pkgContent = fs.readFileSync(pkgPath, 'utf8');
      const lockContent = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
      const currentHash = crypto.createHash('md5').update(pkgContent + lockContent).digest('hex');

      // 讀取上次安裝時的 hash
      let lastHash = '';
      if (fs.existsSync(hashFile)) {
        lastHash = fs.readFileSync(hashFile, 'utf8').trim();
      }

      // 檢查是否需要重新安裝
      const needInstall = !fs.existsSync(nodeModulesPath) || currentHash !== lastHash;

      if (needInstall) {
        if (currentHash !== lastHash && lastHash) {
          log(`偵測到依賴變更 (hash changed)，重新安裝...`);
        } else if (!fs.existsSync(nodeModulesPath)) {
          log(`node_modules 不存在，執行安裝...`);
        }
        log(`執行 npm install...`);
        execSync('npm install', { cwd: projectDir, stdio: 'pipe' });
        // 儲存 hash
        fs.writeFileSync(hashFile, currentHash);
        log(`依賴安裝完成`);
      }
    }

    // 執行 build command
    if (project.buildCommand) {
      log(`執行 build: ${project.buildCommand}`);
      execSync(project.buildCommand, { cwd: projectDir, stdio: 'pipe' });
      log(`Build 完成`);
    }

    // 自動偵測入口檔案
    let entryFile = project.entryFile;
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.main) {
          entryFile = pkg.main;
          log(`從 package.json 偵測入口: ${entryFile}`);
        }
      } catch (e) {
        // ignore
      }
    }
    // Fallback: 檢查常見入口檔案
    if (!fs.existsSync(path.join(projectDir, entryFile))) {
      const candidates = ['server.js', 'app.js', 'index.js', 'main.js'];
      for (const c of candidates) {
        if (fs.existsSync(path.join(projectDir, c))) {
          log(`找到入口檔案: ${c}`);
          entryFile = c;
          break;
        }
      }
    }
    // 更新專案配置
    if (entryFile !== project.entryFile) {
      updateProject(project.id, { entryFile });
      project.entryFile = entryFile;
    }

    // PM2 重啟
    if (project.pm2Name) {
      const entryPath = path.join(projectDir, entryFile);
      if (!fs.existsSync(entryPath)) {
        throw new Error(`入口檔案不存在: ${entryFile}`);
      }
      log(`重啟 PM2: ${project.pm2Name}`);

      // 準備環境變數
      const pm2Env = project.port ? { PORT: String(project.port) } : {};

      try {
        // 嘗試重啟（如果已存在）
        execSync(`pm2 reload ${project.pm2Name}`, { stdio: 'pipe' });
        log(`PM2 重啟完成`);
      } catch (e) {
        log(`PM2 重啟失敗，嘗試啟動...`);
        // 先刪除舊的（如果有）
        try {
          execSync(`pm2 delete ${project.pm2Name}`, { stdio: 'pipe' });
        } catch (delErr) {
          // 忽略刪除錯誤
        }
        // 使用 spawn 啟動 PM2，正確傳遞環境變數
        const pm2Args = ['start', entryPath, '--name', project.pm2Name];
        const spawnEnv = { ...process.env, ...pm2Env };
        execSync(`pm2 start "${entryPath}" --name ${project.pm2Name}`, {
          stdio: 'pipe',
          cwd: projectDir,
          env: spawnEnv
        });
        log(`PM2 啟動完成 (port: ${project.port || 'default'})`);
      }

      // Health Check：確認服務啟動
      if (project.port) {
        log(`執行 Health Check (port: ${project.port})...`);
        const healthCheckPassed = await performHealthCheck(project.port, project.healthEndpoint || '/health', log);
        if (!healthCheckPassed) {
          throw new Error(`Health Check 失敗：服務未能在 port ${project.port} 啟動`);
        }
        log(`Health Check 通過`);
      }
    }

    // 自動建立 DNS (Cloudflare Tunnel)
    const hostname = `${project.id}.isnowfriend.com`;
    try {
      execSync(`"${CLOUDFLARED}" tunnel route dns ${TUNNEL_ID} ${hostname}`, { stdio: 'ignore' });
      log(`DNS 已建立: ${hostname}`);
    } catch (e) {
      log(`DNS 建立失敗（可能已存在）: ${e.message}`);
    }

    // 更新 Tunnel Ingress 規則
    if (project.port) {
      log(`更新 Tunnel Ingress: ${hostname} -> localhost:${project.port}`);
      updateTunnelIngress(hostname, project.port);
    }

    // 更新部署狀態
    const finishedAt = new Date().toISOString();
    deployment.status = 'success';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.logs = logs;

    log(`部署成功！耗時 ${deployment.duration}ms`);

  } catch (error) {
    const finishedAt = new Date().toISOString();
    deployment.status = 'failed';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.error = error.message;
    log(`部署失敗: ${error.message}`);
    deployment.logs = logs;
  }

  // 更新部署記錄
  const allDeployments = readDeployments();
  const deployIndex = allDeployments.findIndex(d => d.id === deployId);
  if (deployIndex !== -1) {
    allDeployments[deployIndex] = deployment;
    writeDeployments(allDeployments);
  }

  // 更新專案最後部署時間
  updateProject(projectId, {
    lastDeployAt: deployment.finishedAt,
    lastDeployStatus: deployment.status
  });

  return deployment;
}

// ==================== 部署記錄 ====================

function getDeployments(projectId, limit = 20) {
  const deployments = readDeployments();
  const filtered = projectId
    ? deployments.filter(d => d.projectId === projectId)
    : deployments;
  return filtered.slice(0, limit);
}

function getDeployment(deployId) {
  return readDeployments().find(d => d.id === deployId);
}

// ==================== Webhook 驗證 ====================

function verifyGitHubWebhook(payload, signature, secret) {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// ==================== GitHub Webhook 自動設定 ====================

// 從 repoUrl 解析 owner/repo
function parseGitHubRepo(repoUrl) {
  // 支援格式：
  // https://github.com/owner/repo.git
  // https://github.com/owner/repo
  // git@github.com:owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  const sshMatch = repoUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)/);
  const match = httpsMatch || sshMatch;
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

// 設定 GitHub Webhook
async function setupGitHubWebhook(projectId, webhookUrl) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    throw new Error(`無法解析 GitHub repo URL: ${project.repoUrl}`);
  }

  const { owner, repo } = parsed;
  const secret = project.webhookSecret;

  console.log(`[deploy] 設定 GitHub Webhook: ${owner}/${repo}`);

  try {
    // 使用 gh CLI 建立 webhook
    const webhookConfig = JSON.stringify({
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: secret,
        insecure_ssl: '0'
      }
    });

    const result = execSync(
      `gh api repos/${owner}/${repo}/hooks --method POST --input -`,
      {
        input: webhookConfig,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    const hookData = JSON.parse(result);
    console.log(`[deploy] Webhook 已建立: ID ${hookData.id}`);

    // 更新專案記錄
    updateProject(projectId, { webhookId: hookData.id });

    return { success: true, webhookId: hookData.id };
  } catch (error) {
    // 檢查是否是 webhook 已存在 (錯誤訊息可能在 stderr 或 message 中)
    const errorOutput = (error.stderr?.toString() || '') + (error.message || '');
    if (errorOutput.includes('Hook already exists') || errorOutput.includes('already exists')) {
      console.log(`[deploy] Webhook 已存在，跳過建立`);
      return { success: true, alreadyExists: true };
    }
    console.error(`[deploy] Webhook 設定失敗:`, errorOutput || error);
    throw new Error(errorOutput || error.message);
  }
}

// 刪除 GitHub Webhook
async function removeGitHubWebhook(projectId) {
  const project = getProject(projectId);
  if (!project || !project.webhookId) {
    return { success: false, error: '無 webhook 記錄' };
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    return { success: false, error: '無法解析 repo URL' };
  }

  const { owner, repo } = parsed;

  try {
    execSync(
      `gh api repos/${owner}/${repo}/hooks/${project.webhookId} --method DELETE`,
      { stdio: 'pipe' }
    );
    console.log(`[deploy] Webhook 已刪除: ID ${project.webhookId}`);
    updateProject(projectId, { webhookId: null });
    return { success: true };
  } catch (error) {
    console.error(`[deploy] Webhook 刪除失敗:`, error.message);
    return { success: false, error: error.message };
  }
}

// 列出專案的 GitHub Webhooks
function listGitHubWebhooks(projectId) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    throw new Error(`無法解析 GitHub repo URL`);
  }

  const { owner, repo } = parsed;

  try {
    const result = execSync(
      `gh api repos/${owner}/${repo}/hooks`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(result);
  } catch (error) {
    console.error(`[deploy] 取得 webhooks 失敗:`, error.message);
    return [];
  }
}

// ==================== GitHub 輪詢（Backup 機制）====================

/**
 * 檢查 GitHub 最新 commit（使用 gh CLI）
 */
function getGitHubLatestCommit(owner, repo, branch) {
  try {
    const result = execSync(
      `gh api repos/${owner}/${repo}/commits/${branch} --jq ".sha"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim().substring(0, 7);
  } catch (e) {
    console.error(`[poll] 無法取得 ${owner}/${repo} 最新 commit:`, e.message);
    return null;
  }
}

/**
 * 檢查單一專案是否需要部署
 */
async function checkProjectForUpdates(project) {
  if (project.deployMethod !== 'github' && project.deployMethod !== 'git-url') {
    return null;
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const remoteCommit = getGitHubLatestCommit(owner, repo, project.branch);

  if (!remoteCommit) return null;

  // 取得本地 commit
  const projectDir = path.join(CLOUDPIPE_ROOT, project.directory);
  let localCommit = null;
  try {
    if (fs.existsSync(projectDir)) {
      localCommit = execSync('git rev-parse --short HEAD', { cwd: projectDir, encoding: 'utf8' }).trim();
    }
  } catch (e) {}

  // 比較
  if (remoteCommit !== localCommit) {
    console.log(`[poll] 偵測到新 commit: ${project.id} (local: ${localCommit}, remote: ${remoteCommit})`);
    return { project, localCommit, remoteCommit };
  }

  return null;
}

/**
 * 輪詢所有專案檢查更新
 */
async function pollAllProjects() {
  const projects = getAllProjects();
  console.log(`[poll] 開始輪詢 ${projects.length} 個專案...`);

  for (const project of projects) {
    try {
      const update = await checkProjectForUpdates(project);
      if (update) {
        console.log(`[poll] 觸發部署: ${project.id}`);
        await deploy(project.id, { triggeredBy: 'poll' });
      }
    } catch (e) {
      console.error(`[poll] 檢查 ${project.id} 失敗:`, e.message);
    }
  }

  console.log(`[poll] 輪詢完成`);
}

// 輪詢定時器
let pollInterval = null;

/**
 * 啟動定時輪詢（每 5 分鐘）
 */
function startPolling(intervalMs = 5 * 60 * 1000) {
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  console.log(`[poll] 啟動定時輪詢 (間隔: ${intervalMs / 1000}s)`);

  // 立即執行一次
  setTimeout(() => pollAllProjects(), 10000);

  // 設定定時輪詢
  pollInterval = setInterval(pollAllProjects, intervalMs);
}

/**
 * 停止定時輪詢
 */
function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log(`[poll] 已停止定時輪詢`);
  }
}

// ==================== 匯出 ====================

module.exports = {
  // 專案管理
  getProject,
  getAllProjects,
  createProject,
  updateProject,
  deleteProject,

  // 部署
  deploy,
  getDeployments,
  getDeployment,

  // Webhook
  verifyGitHubWebhook,
  setupGitHubWebhook,
  removeGitHubWebhook,
  listGitHubWebhooks,
  parseGitHubRepo,

  // 輪詢
  startPolling,
  stopPolling,
  pollAllProjects,
  checkProjectForUpdates
};
