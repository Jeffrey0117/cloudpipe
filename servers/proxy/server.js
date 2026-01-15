const http = require('http');
const https = require('https');
const url = require('url');

module.exports = function createProxyServer(config) {
  const { target, port, name } = config;

  const server = http.createServer((req, res) => {
    // Handle OPTIONS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    const targetUrl = target + req.url;
    console.log(`[${name}] ${req.method} ${req.url} -> ${targetUrl}`);

    const parsedTarget = url.parse(targetUrl);
    const httpModule = parsedTarget.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
      path: parsedTarget.path,
      method: req.method,
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
      },
    };

    const proxyReq = httpModule.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        "content-type": proxyRes.headers["content-type"] || "application/json",
        "access-control-allow-origin": "*",
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error(`[${name}] ERROR: ${e.message}`);
      res.writeHead(502, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ error: e.message }));
    });

    req.pipe(proxyReq);
  });

  return server;
};
