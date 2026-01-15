# Cloudpipe

Deploy APIs to the internet in seconds. Drop a `.js` file, run `start.bat`, done.

## Quick Start

```bash
# 1. Install cloudflared (one time)
winget install Cloudflare.cloudflared
cloudflared tunnel login

# 2. Drop your API file
# Copy your server.js to services/myapi.js

# 3. Run
start.bat
```

Your API is now live at `https://api.yourdomain.com`

---

## Services Mode (80% of use cases)

Just drop a `.js` file in the `services/` directory. That's it.

### Creating a Service

Your `.js` file must export a function that creates an HTTP server:

```javascript
// services/myapi.js
const http = require('http');

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

    // Your API logic
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Hello World!' }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
};
```

### How It Works

1. Cloudpipe scans `services/` for `.js` files
2. Each service runs on the configured port
3. All services share the same subdomain (e.g., `api.yourdomain.com`)
4. The tunnel routes traffic to your local servers

### Config

```json
{
  "domain": "yourdomain.com",
  "port": 8787,
  "subdomain": "api",
  "cloudflared_path": "...",
  "standalone": []
}
```

| Field | Description |
|-------|-------------|
| `domain` | Your Cloudflare domain |
| `port` | Local port for services |
| `subdomain` | Subdomain for your API (e.g., `api` -> `api.yourdomain.com`) |
| `cloudflared_path` | Path to cloudflared.exe |
| `standalone` | Array of standalone services (see below) |

---

## Standalone Mode (20% of use cases)

For complex services that need their own configuration.

### When to Use

- Service needs multiple routes/subdomains
- Service needs custom tunnel ingress rules
- Service has its own folder structure

### Setup

1. Create a folder in `standalone/`
2. Add to `config.json`:

```json
{
  "standalone": [
    {
      "name": "complex-api",
      "entry": "standalone/complex-api/server.js",
      "port": 8800,
      "subdomain": "complex"
    }
  ]
}
```

---

## Template Reference

### Basic API Template

```javascript
const http = require('http');

module.exports = function(config) {
  return http.createServer((req, res) => {
    // CORS
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Routes
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }

    // Handle POST body
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const data = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: data }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
};
```

### Proxy Template

Forward requests to another API:

```javascript
const http = require('http');
const https = require('https');
const url = require('url');

module.exports = function(config) {
  const TARGET = 'https://api.example.com';  // Change this

  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      return res.end();
    }

    const targetUrl = TARGET + req.url;
    const parsed = url.parse(targetUrl);
    const httpModule = parsed.protocol === 'https:' ? https : http;

    const proxyReq = httpModule.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path,
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json' }
    }, proxyRes => {
      res.writeHead(proxyRes.statusCode, {
        'content-type': proxyRes.headers['content-type'] || 'application/json',
        'access-control-allow-origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', e => {
      res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    });

    req.pipe(proxyReq);
  });
};
```

---

## Example Workflow with AI

You: "Create an API that returns random quotes"

AI creates `services/quotes.js`:
```javascript
const http = require('http');

const quotes = [
  "The only way to do great work is to love what you do.",
  "Innovation distinguishes between a leader and a follower.",
  "Stay hungry, stay foolish."
];

module.exports = function(config) {
  return http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');

    if (req.url === '/random') {
      const quote = quotes[Math.floor(Math.random() * quotes.length)];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ quote }));
    }

    if (req.url === '/all') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ quotes }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Try /random or /all' }));
  });
};
```

You: Run `start.bat`

Result: `https://api.yourdomain.com/random` returns a random quote.

---

## Files

```
cloudpipe/
  config.json      - Configuration
  start.bat        - Start everything
  index.js         - Service loader
  tunnel.js        - Cloudflare tunnel manager
  services/        - Drop your .js files here
  standalone/      - Advanced standalone services
```
