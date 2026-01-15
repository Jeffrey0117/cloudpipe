# CloudPipe

Personal Deploy Platform - 個人部署平台

透過 Cloudflare Tunnel 將本地服務快速部署到公網。

## 功能

### 兩種部署模式

| 模式 | 網址 | 說明 |
|------|------|------|
| API 服務 | `epi.isnowfriend.com/xxx` | 路徑式，適合 API、Webhook |
| 專案部署 | `xxx.isnowfriend.com` | 子域名式，適合完整網站 |

### 特色

- **Dashboard UI** - 視覺化管理介面
- **拖拽上傳** - 丟檔案即部署
- **自動 DNS** - 上傳時自動建立 CNAME
- **熱載入** - 不需重啟服務
- **靜態 + 後端** - 支援純靜態或 Node.js 應用

## 快速開始

```bash
# 啟動
start.bat

# 或
node index.js
```

打開 `https://epi.isnowfriend.com` 進入 Dashboard。

## 目錄結構

```
cloudpipe/
├── index.js              # 入口
├── config.json           # 設定
├── start.bat             # 一鍵啟動
├── cloudflared.yml       # Tunnel 設定
├── SPEC.md               # 規格文檔
│
├── public/               # Dashboard 前端
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── services/             # API 服務（路徑式）
│   └── proxy.js          # 範例：Railway 代理
│
├── apps/                 # 專案（子域名式）
│   └── {app-name}/
│       ├── index.html    # 靜態網站
│       └── server.js     # 或 Node.js 後端
│
└── src/core/             # 核心（勿動）
    ├── server.js
    ├── registry.js
    ├── router.js
    └── admin.js
```

## API 服務範例

```javascript
// services/my-api.js
module.exports = {
  match(req) {
    return req.url.startsWith('/my-api');
  },
  handle(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  }
};
```

## 專案範例

### 靜態網站
```
apps/blog/
└── index.html
```
存取：`https://blog.isnowfriend.com`

### Node.js 應用
```
apps/api/
└── server.js
```

```javascript
// apps/api/server.js
module.exports = function(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
};
```
存取：`https://api.isnowfriend.com`

## 設定

`config.json`:
```json
{
  "domain": "isnowfriend.com",
  "port": 8787,
  "subdomain": "epi"
}
```

## License

MIT
