# CloudPipe

本地服務快速部署網關。透過 Cloudflare Tunnel 將本地服務暴露到公網。

## 功能

- **路徑式部署**: `api.isnowfriend.com/myapp` → 轉發到指定服務
- **子域名式部署**: `myapp.isnowfriend.com` → 轉發到指定服務
- **熱載入**: 丟 `.js` 檔到 `services/` 即生效
- **自動路由**: 根據 `match()` 規則匹配請求

## 目錄結構

```
cloudpipe/
├── index.js          # 入口
├── config.json       # 設定
├── start.bat         # 一鍵啟動（服務 + tunnel）
├── cloudflared.yml   # Tunnel 設定
├── src/core/         # 核心程式
│   ├── server.js     # 啟動器
│   ├── registry.js   # 服務註冊
│   └── router.js     # 路由器
├── services/         # 你的服務放這裡
│   ├── _example.js   # 範例（底線開頭不載入）
│   └── proxy.js      # Railway 代理服務
└── public/
    └── index.html    # 首頁
```

## 快速開始

1. **建立服務檔** - 在 `services/` 新增 `.js` 檔案
2. **執行** - 點 `start.bat` 或 `node index.js`
3. **存取** - 透過 `api.isnowfriend.com` 訪問

## 服務範例

```javascript
// services/my-api.js
module.exports = {
  // 匹配 /my-api/* 路徑
  match(req) {
    return req.url.startsWith('/my-api');
  },

  // 處理請求
  handle(req, res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hello: 'world' }));
  }
};
```

## 代理範例

```javascript
// services/proxy.js - 轉發到其他服務
const https = require('https');
const { URL } = require('url');

const TARGET = 'https://your-api.example.com';

module.exports = {
  match(req) {
    return req.url.startsWith('/api');
  },

  handle(req, res) {
    const targetUrl = new URL(req.url, TARGET);
    // ... 轉發邏輯
  }
};
```

## 設定

`config.json`:
```json
{
  "domain": "isnowfriend.com",
  "port": 8787,
  "subdomain": "api"
}
```

## Tunnel 設定

`cloudflared.yml`:
```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.isnowfriend.com
    service: http://localhost:8787
  - hostname: "*.isnowfriend.com"
    service: http://localhost:8787
  - service: http_status:404
```
