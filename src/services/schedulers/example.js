const http = require('http');

// Example API service
// Rename this file and modify for your needs

module.exports = function(config) {
  return http.createServer((req, res) => {
    // CORS headers (always include these)
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    console.log(`[${config.name}] ${req.method} ${req.url}`);

    // Health check
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        service: config.name,
        timestamp: new Date().toISOString()
      }));
    }

    // Your API routes here
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Hello World!' }));
    }

    // 404 for unknown routes
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
};
