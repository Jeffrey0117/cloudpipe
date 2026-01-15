/**
 * CloudPipe Dashboard
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 狀態
let currentType = null; // 'service' | 'app'
let existingServices = []; // 已存在的服務名稱
let existingApps = []; // 已存在的 app 名稱

// DOM 元素
const uploadZone = $('#uploadZone');
const uploadTitle = $('#uploadTitle');
const guideText = $('#guideText');
const nameInput = $('#nameInput');
const nameLabel = $('#nameLabel');
const serviceName = $('#serviceName');
const nameSuffix = $('#nameSuffix');
const nameHint = $('#nameHint');
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const uploadHint = $('#uploadHint');
const uploadStatus = $('#uploadStatus');
const statusText = $('#statusText');
const deployedList = $('#deployedList');

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initCards();
  initUpload();
  loadDeployed();
});

// 卡片點擊
function initCards() {
  $$('.card').forEach(card => {
    card.addEventListener('click', () => {
      const type = card.dataset.type;
      
      // 切換 active
      $$('.card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      
      // 顯示上傳區
      showUpload(type);
    });
  });
  
  // 關閉按鈕
  $('#closeUpload').addEventListener('click', hideUpload);
}

// 顯示上傳區
function showUpload(type) {
  currentType = type;
  uploadZone.classList.remove('hidden');
  uploadStatus.classList.add('hidden');
  dropzone.style.display = 'block';
  serviceName.value = '';

  if (type === 'service') {
    uploadTitle.textContent = '上傳 API 服務';
    nameLabel.textContent = 'API 名稱';
    nameSuffix.textContent = '';
    serviceName.placeholder = 'ytdownload';
    uploadHint.textContent = '或點擊選擇 .js 檔案';
    fileInput.accept = '.js';
    guideText.innerHTML = '檔名 <code>xxx.js</code> 會依你的命名存成 → <code>epi.isnowfriend.com/你的名稱</code>';
    updateNameHint('service');
  } else {
    uploadTitle.textContent = '部署專案';
    nameLabel.textContent = '子域名';
    nameSuffix.textContent = '.isnowfriend.com';
    serviceName.placeholder = 'blog';
    uploadHint.textContent = '或點擊選擇 .zip 檔案';
    fileInput.accept = '.zip';
    guideText.innerHTML = '上傳後可透過 <code>你的名稱.isnowfriend.com</code> 存取';
    updateNameHint('app');
  }
}

// 更新名稱提示（顯示已佔用）
function updateNameHint(type) {
  const existing = type === 'service' ? existingServices : existingApps;
  if (existing.length > 0) {
    nameHint.textContent = '已使用: ' + existing.join(', ');
  } else {
    nameHint.textContent = '';
  }
}

// 隱藏上傳區
function hideUpload() {
  uploadZone.classList.add('hidden');
  $$('.card').forEach(c => c.classList.remove('active'));
  currentType = null;
}

// 初始化上傳
function initUpload() {
  // 點擊上傳
  dropzone.addEventListener('click', () => fileInput.click());
  
  // 檔案選擇
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleUpload(e.target.files[0]);
    }
  });
  
  // 拖拽
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files[0]);
    }
  });
}

// 處理上傳
async function handleUpload(file) {
  // 驗證檔案類型
  if (currentType === 'service' && !file.name.endsWith('.js')) {
    alert('請上傳 .js 檔案');
    return;
  }
  if (currentType === 'app' && !file.name.endsWith('.zip')) {
    alert('請上傳 .zip 檔案');
    return;
  }

  // 取得名稱
  const name = serviceName.value.trim();
  if (!name) {
    alert('請輸入名稱');
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    alert('名稱只能包含小寫字母、數字和連字符');
    return;
  }

  // 檢查衝突
  const existing = currentType === 'service' ? existingServices : existingApps;
  if (existing.includes(name)) {
    alert(`名稱 "${name}" 已被使用，請換一個`);
    return;
  }

  // 顯示上傳中
  dropzone.style.display = 'none';
  nameInput.style.display = 'none';
  uploadStatus.classList.remove('hidden', 'success', 'error');
  statusText.textContent = '上傳中...';

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name);

    const endpoint = currentType === 'service'
      ? '/api/_admin/upload/service'
      : '/api/_admin/upload/app';

    const res = await fetch(endpoint, {
      method: 'POST',
      body: formData
    });

    const data = await res.json();

    if (data.success) {
      uploadStatus.classList.add('success');
      statusText.innerHTML = `部署成功！<br><a href="${data.url}" target="_blank">${data.url}</a>`;
      loadDeployed();
    } else {
      throw new Error(data.error || '上傳失敗');
    }
  } catch (err) {
    uploadStatus.classList.add('error');
    statusText.textContent = err.message;
  }
}

// 載入已部署列表
async function loadDeployed() {
  try {
    const res = await fetch('/api/_admin/services');
    const data = await res.json();

    // 記錄已存在的名稱
    existingServices = data.services.map(s => s.name);
    existingApps = data.apps.map(a => a.name);

    if (data.services.length === 0 && data.apps.length === 0) {
      deployedList.innerHTML = '<div class="empty">尚無部署的服務</div>';
      return;
    }

    let html = '';
    
    // Services
    data.services.forEach(s => {
      html += `
        <div class="deployed-item" data-type="service" data-name="${s.name}">
          <div class="info">
            <span class="icon">📡</span>
            <div>
              <div class="name">${s.name}</div>
              <div class="url">${s.url}</div>
            </div>
          </div>
          <div class="status">運行中</div>
          <div class="actions">
            <button class="delete" onclick="deleteItem('service', '${s.name}')">刪除</button>
          </div>
        </div>
      `;
    });
    
    // Apps
    data.apps.forEach(a => {
      html += `
        <div class="deployed-item" data-type="app" data-name="${a.name}">
          <div class="info">
            <span class="icon">🌐</span>
            <div>
              <div class="name">${a.name}</div>
              <div class="url">${a.url}</div>
            </div>
          </div>
          <div class="status">運行中</div>
          <div class="actions">
            <button class="delete" onclick="deleteItem('app', '${a.name}')">刪除</button>
          </div>
        </div>
      `;
    });
    
    deployedList.innerHTML = html;
  } catch (err) {
    deployedList.innerHTML = '<div class="empty">無法載入服務列表</div>';
  }
}

// 刪除項目
async function deleteItem(type, name) {
  if (!confirm(`確定要刪除 ${name}？`)) return;
  
  try {
    const endpoint = type === 'service'
      ? `/api/_admin/service/${name}`
      : `/api/_admin/app/${name}`;
    
    const res = await fetch(endpoint, { method: 'DELETE' });
    const data = await res.json();
    
    if (data.success) {
      loadDeployed();
    } else {
      alert(data.error || '刪除失敗');
    }
  } catch (err) {
    alert('刪除失敗: ' + err.message);
  }
}
