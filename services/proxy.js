/**
 * Proxy 路由 - 轉發到 Railway API
 */

const https = require('https');
const { URL } = require('url');

const TARGET = 'https://api-production-1ea7.up.railway.app';

module.exports = {
  // 匹配 /api/* 路徑
  match(req) {
    return req.url.startsWith('/api');
  },

  // 轉發請求
  handle(req, res) {
    const targetUrl = new URL(req.url, TARGET);

    console.log(`[proxy] -> ${targetUrl.href}`);

    const options = {
      hostname: targetUrl.hostname,
      port: 443,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: { ...req.headers, host: targetUrl.hostname }
    };

    delete options.headers['connection'];

    const proxyReq = https.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers['content-encoding'];

      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy] Error:', err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    });

    req.pipe(proxyReq);
  }
};
