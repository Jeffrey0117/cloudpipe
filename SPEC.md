# CloudPipe 規格文檔

> Personal Deploy Platform - 個人部署平台

## 概述

CloudPipe 是一個輕量級的本地部署平台，透過 Cloudflare Tunnel 將本地服務暴露到公網。

## 兩種部署模式

### 1. API 服務（路徑式）
- 網址：`epi.isnowfriend.com/xxx`
- 用途：API 轉發、Webhook 接收、後端服務
- 存放：`services/` 目錄
- 檔案：單一 `.js` 檔案

### 2. 專案部署（子域名式）
- 網址：`xxx.isnowfriend.com`
- 用途：靜態網站、完整 Web App
- 存放：`apps/xxx/` 目錄
- 結構：
  - 靜態網站：`public/` 資料夾
  - 後端應用：`server.js` 入口

## 目錄結構

```
cloudpipe/
├── index.js              # 入口
├── config.json           # 設定
├── start.bat             # Windows 啟動腳本
├── cloudflared.yml       # Tunnel 設定
├── SPEC.md               # 本規格文檔
├── README.md             # 使用說明
│
├── src/core/             # 核心程式（勿動）
│   ├── server.js         # 啟動器
│   ├── registry.js       # 服務註冊
│   └── router.js         # 路由器
│
├── public/               # Dashboard 前端
│   ├── index.html        # 首頁/Dashboard
│   ├── style.css         # 樣式
│   └── app.js            # 前端邏輯
│
├── services/             # API 服務（路徑式）
│   ├── _example.js       # 範例（底線=不載入）
│   └── proxy.js          # Railway 代理
│
└── apps/                 # 專案部署（子域名式）
    └── {app-name}/
        ├── public/       # 靜態檔案
        └── server.js     # 後端入口（可選）
```

## Dashboard UI 規格

### 首頁 (`/`)

#### Header
- 標題：CloudPipe
- 副標：Personal Deploy Platform

#### 兩個主要入口卡片

**卡片 1：API 服務**
- 圖示：📡
- 標題：API 服務
- 說明：路徑式部署，掛在 epi.isnowfriend.com/xxx
- 點擊：展開上傳區

**卡片 2：專案部署**
- 圖示：🌐
- 標題：專案部署
- 說明：子域名式，建立 xxx.isnowfriend.com
- 點擊：展開上傳區 + 輸入子域名

#### 已部署列表
- 顯示所有運行中的服務和專案
- 欄位：名稱、網址、狀態、操作（停用/刪除）

### 上傳流程

#### API 服務上傳
1. 點擊「API 服務」卡片
2. 拖拽 `.js` 檔案或點擊選擇
3. 上傳後自動部署到 `services/`
4. 顯示存取網址

#### 專案部署上傳
1. 點擊「專案部署」卡片
2. 輸入子域名名稱（如 `blog`）
3. 拖拽資料夾或 `.zip`
4. 上傳後自動解壓到 `apps/{name}/`
5. 自動設定 DNS
6. 顯示存取網址

## API 端點規格

### GET /api/_admin/services
列出所有服務
```json
{
  "services": [
    { "name": "proxy", "path": "/api/*", "status": "running" }
  ],
  "apps": [
    { "name": "blog", "hostname": "blog.isnowfriend.com", "status": "running" }
  ]
}
```

### POST /api/_admin/upload/service
上傳 API 服務
- Body: multipart/form-data, file: .js 檔案
- Response: `{ "success": true, "name": "xxx", "url": "epi.../xxx" }`

### POST /api/_admin/upload/app
上傳專案
- Body: multipart/form-data, file: .zip, name: 子域名
- Response: `{ "success": true, "name": "xxx", "url": "xxx.isnowfriend.com" }`

### DELETE /api/_admin/service/:name
刪除服務

### DELETE /api/_admin/app/:name
刪除專案

## 路由邏輯

```
請求進來
    ↓
檢查 hostname
    ↓
├── epi.isnowfriend.com
│   ├── /                → Dashboard (public/index.html)
│   ├── /health          → 健康檢查
│   ├── /api/_admin/*    → 管理 API
│   └── /其他            → services/*.js 匹配
│
└── xxx.isnowfriend.com
    ├── apps/xxx/server.js 存在 → 執行後端
    └── apps/xxx/public/ 存在   → 靜態檔案
```

## 開發任務

### Phase 1: Dashboard UI
- [ ] 更新 public/index.html - 新版首頁
- [ ] 新增 public/style.css - 樣式
- [ ] 新增 public/app.js - 前端邏輯

### Phase 2: 管理 API
- [ ] 新增 services/_admin.js - 管理端點
- [ ] 實作 GET /api/_admin/services
- [ ] 實作 POST /api/_admin/upload/service
- [ ] 實作 POST /api/_admin/upload/app
- [ ] 實作 DELETE 端點

### Phase 3: 多域名路由
- [ ] 修改 router.js 支援 hostname 判斷
- [ ] 新增 apps/ 目錄支援
- [ ] 靜態檔案服務
- [ ] 後端應用支援

### Phase 4: DNS 自動化
- [ ] 上傳專案時自動建立 DNS CNAME
- [ ] 刪除專案時移除 DNS

## 技術備註

- 前端：純 HTML/CSS/JS，無框架
- 後端：Node.js 原生 HTTP
- 上傳：使用 multipart/form-data
- 儲存：直接存到檔案系統
