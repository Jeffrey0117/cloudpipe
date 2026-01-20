/**
 * MST API - CloudPipe 版
 * 測速 API，使用 Netflix/fast.com CDN 節點
 *
 * 端點：
 *   GET  /mst/targets  - 取得測速節點
 *   POST /mst/results  - 回報測速結果
 *   GET  /mst/health   - 健康檢查
 */

const CONFIG = {
  cdn: {
    apiEndpoint: 'https://api.fast.com/netflix/speedtest/v2',
    token: 'YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm',
    defaultUrlCount: 5,
  },
};

/**
 * 取得測速節點
 */
async function getTargets(preferredCountry = 'TW', count = 3) {
  const params = new URLSearchParams({
    https: 'true',
    token: CONFIG.cdn.token,
    urlCount: String(CONFIG.cdn.defaultUrlCount),
  });

  const response = await fetch(`${CONFIG.cdn.apiEndpoint}?${params}`);

  if (!response.ok) {
    throw new Error(`CDN API error: ${response.status}`);
  }

  const data = await response.json();

  if (!data.targets || data.targets.length === 0) {
    throw new Error('No targets available');
  }

  // 優先選擇指定國家的節點
  let targets = data.targets.filter(
    (t) => t.location?.country === preferredCountry
  );

  if (targets.length === 0) {
    targets = data.targets;
  }

  return targets.slice(0, Math.min(count, 5)).map((t) => ({
    url: t.url,
    city: t.location?.city || 'Unknown',
    country: t.location?.country || 'Unknown',
  }));
}

/**
 * 解析 query string
 */
function parseQuery(url) {
  const q = {};
  const queryString = url.split('?')[1];
  if (queryString) {
    queryString.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      q[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
  }
  return q;
}

/**
 * 讀取 POST body
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/**
 * CORS Headers
 */
function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ============================================================
// CloudPipe Service 格式
// ============================================================
module.exports = {
  match(req) {
    return req.url.startsWith('/mst');
  },

  async handle(req, res) {
    const urlPath = req.url.split('?')[0].replace(/^\/mst/, '') || '/';
    const query = parseQuery(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, corsHeaders());
      res.end();
      return;
    }

    try {
      // GET /mst/targets
      if (req.method === 'GET' && urlPath === '/targets') {
        const count = Math.min(parseInt(query.count) || 3, 5);
        const country = query.country || 'TW';
        const targets = await getTargets(country, count);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ success: true, targets }));
        return;
      }

      // POST /mst/results
      if (req.method === 'POST' && urlPath === '/results') {
        const body = await readBody(req);
        const { speed, bytes, duration } = body;

        if (!speed || typeof speed.raw !== 'number') {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ success: false, error: 'Invalid speed data' }));
          return;
        }

        const id = `mst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        console.log('[MST] Result:', JSON.stringify({ id, speed, bytes, duration }));

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ success: true, id }));
        return;
      }

      // GET /mst/health
      if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/')) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          success: true,
          name: 'MySpeedTest API',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // 404
      res.writeHead(404, corsHeaders());
      res.end(JSON.stringify({ success: false, error: 'Not found' }));

    } catch (error) {
      console.error('[MST] Error:', error.message);
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  }
};
