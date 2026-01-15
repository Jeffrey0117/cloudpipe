const http = require('http');

// Example custom API server
// Copy this file and modify for your needs

module.exports = function createCustomServer(config) {
  const { port, name } = config;

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    console.log(`[${name}] ${req.method} ${req.url}`);

    // Your API logic here
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: name,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
};
