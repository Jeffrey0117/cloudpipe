# CloudPipe 架構說明

> 建立日期：2026-01-19

---

## 專案結構

```
CloudPipe (主平台)
│
├── /_admin                    ← CloudPipe 主控台（給平台管理員）
│   ├── admin.html             ← 主控台首頁，顯示所有子專案狀態
│   ├── admin-lurlhub.html     ← LurlHub 的「概覽」（統計、日誌、快捷連結）
│   └── admin-settings.html    ← CloudPipe 平台設定
│
└── /lurl                      ← LurlHub 子專案（獨立運作）
    ├── /lurl/admin            ← LurlHub 自己的管理後台（lurl.js 生成）
    │   ├── 記錄管理（影片/圖片列表）
    │   ├── 使用者管理（額度、設備、貢獻）  ← 應該在這裡
    │   ├── 版本控制
    │   └── 維護工具
    ├── /lurl/browse           ← 公開的瀏覽頁面
    ├── /lurl/login            ← 登入頁面
    └── /lurl/api/*            ← LurlHub API 端點
```

---

## 重要區分

### `/_admin` vs `/lurl/admin`

| 路徑 | 用途 | 檔案來源 |
|------|------|----------|
| `/_admin` | CloudPipe 平台總控台 | `public/admin*.html` 靜態檔案 |
| `/lurl/admin` | LurlHub 專案管理後台 | `services/lurl.js` 動態生成 |

### 為什麼這樣設計？

1. **CloudPipe 是平台**
   - 可以掛載多個子專案（目前只有 LurlHub）
   - `/_admin` 是看「全局狀態」的地方

2. **LurlHub 是子專案**
   - 有自己完整的管理後台 `/lurl/admin`
   - 所有 LurlHub 相關的管理功能都應該在這裡
   - 包含：記錄管理、使用者管理、版本控制、維護工具

3. **`/_admin/lurlhub`（admin-lurlhub.html）的角色**
   - 只是一個「概覽」和「快捷入口」
   - 顯示 LurlHub 的統計數據
   - 提供跳轉到 `/lurl/admin` 的連結
   - **不應該**放 LurlHub 的詳細管理功能

---

## 檔案對應

```
public/
├── admin.html              → /_admin
├── admin-lurlhub.html      → /_admin/lurlhub  (LurlHub 概覽)
├── admin-settings.html     → /_admin/settings
└── admin-users.html        → ❌ 錯誤！這個不該存在

services/
└── lurl.js                 → /lurl/*  (所有 LurlHub 路由)
    ├── adminPage()         → /lurl/admin  (LurlHub 管理後台)
    ├── browsePage()        → /lurl/browse
    └── loginPage()         → /lurl/login
```

---

## 正確做法

### 新增 LurlHub 功能時

- 如果是 **LurlHub 專屬功能**（如使用者管理）
  → 加在 `lurl.js` 的 `adminPage()` 裡，用 tab 切換

- 如果是 **CloudPipe 平台功能**
  → 加在 `public/admin*.html`

### 範例：使用者管理

❌ 錯誤：`public/admin-users.html` → `/_admin/users`
✅ 正確：在 `lurl.js` 的 `adminPage()` 加一個「使用者」tab

---

## API 端點

### LurlHub API（都在 `/lurl/api/*`）

| 端點 | 用途 | 驗證 |
|------|------|------|
| `POST /lurl/api/rpc` | 統一 RPC 入口 | 視 action 而定 |
| `GET /lurl/api/users` | 使用者列表 | Admin |
| `PATCH /lurl/api/users/:id` | 更新使用者 | Admin |
| `GET /lurl/api/stats` | 統計數據 | 無 |
| `GET /lurl/api/records` | 記錄列表 | Admin |

### RPC Action 對照

| Action | 功能 | 驗證 |
|--------|------|------|
| `cb` | check-backup | visitorId |
| `rc` | recover | visitorId |
| `vr` | version | 無 |
| `bl` | blocked-urls | CLIENT_TOKEN |
| `rd` | report-device | visitorId |
