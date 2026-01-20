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

  const project = {
    id: data.id,
    name: data.name || data.id,
    description: data.description || '',
    deployMethod: data.deployMethod || 'manual', // github | git-url | upload | manual
    repoUrl: data.repoUrl || '',
    branch: data.branch || 'main',
    directory: data.directory || `projects/${data.id}`,
    entryFile: data.entryFile || 'index.js',
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

    // 執行 build command
    if (project.buildCommand) {
      log(`執行 build: ${project.buildCommand}`);
      execSync(project.buildCommand, { cwd: projectDir, stdio: 'pipe' });
      log(`Build 完成`);
    }

    // 自動偵測入口檔案
    let entryFile = project.entryFile;
    const pkgPath = path.join(projectDir, 'package.json');
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
      const portEnv = project.port ? `PORT=${project.port}` : '';
      try {
        execSync(`pm2 reload ${project.pm2Name}`, { stdio: 'pipe' });
        log(`PM2 重啟完成`);
      } catch (e) {
        log(`PM2 重啟失敗，嘗試啟動...`);
        // 啟動時帶入 PORT 環境變數
        const startCmd = portEnv
          ? `cross-env ${portEnv} pm2 start ${entryPath} --name ${project.pm2Name}`
          : `pm2 start ${entryPath} --name ${project.pm2Name}`;
        execSync(startCmd, { stdio: 'pipe', cwd: projectDir });
        log(`PM2 啟動完成 (port: ${project.port || 'default'})`);
      }
    }

    // 自動建立 DNS (Cloudflare Tunnel)
    try {
      const hostname = `${project.id}.isnowfriend.com`;
      execSync(`"${CLOUDFLARED}" tunnel route dns ${TUNNEL_ID} ${hostname}`, { stdio: 'ignore' });
      log(`DNS 已建立: ${hostname}`);
    } catch (e) {
      log(`DNS 建立失敗: ${e.message}`);
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
  verifyGitHubWebhook
};
