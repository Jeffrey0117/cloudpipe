const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Resolve cloudflared path
let cfPath = config.cloudflared_path;
cfPath = cfPath.replace(/%([^%]+)%/g, (_, key) => process.env[key] || '');

if (!fs.existsSync(cfPath)) {
  console.log('[!] cloudflared not found at:', cfPath);
  console.log('    Install: winget install Cloudflare.cloudflared');
  process.exit(1);
}

console.log('[OK] Found cloudflared:', cfPath);

// Collect all services (same logic as index.js)
const services = [];

// 1. Scan src/services/schedulers/ directory
const schedulersDir = path.join(__dirname, 'src', 'services', 'schedulers');
if (fs.existsSync(schedulersDir)) {
  const files = fs.readdirSync(schedulersDir).filter(f => f.endsWith('.js'));
  if (files.length > 0) {
    // All schedulers share the same subdomain/port
    services.push({
      subdomain: config.subdomain,
      port: config.port
    });
  }
}

// 2. Scan src/services/standalone/{name}/ directories
const standaloneDir = path.join(__dirname, 'src', 'services', 'standalone');
if (fs.existsSync(standaloneDir)) {
  const dirs = fs.readdirSync(standaloneDir).filter(d => {
    const fullPath = path.join(standaloneDir, d);
    return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'index.js'));
  });
  dirs.forEach(d => {
    const configPath = path.join(standaloneDir, d, 'config.json');
    let serviceConfig = {};
    if (fs.existsSync(configPath)) {
      serviceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    services.push({
      subdomain: serviceConfig.subdomain || d,
      port: serviceConfig.port || config.port + services.length
    });
  });
}

// 3. Add standalone services from config.json
if (config.standalone && config.standalone.length > 0) {
  config.standalone.forEach(s => {
    services.push({
      subdomain: s.subdomain,
      port: s.port
    });
  });
}

if (services.length === 0) {
  console.log('[!] No services found');
  process.exit(1);
}

// Ensure tunnels directory exists
const tunnelsDir = path.join(__dirname, 'tunnels');
if (!fs.existsSync(tunnelsDir)) {
  fs.mkdirSync(tunnelsDir);
}

// Generate tunnel config
const tunnelConfigPath = path.join(tunnelsDir, 'cloudpipe-config.yml');

// Check if tunnel exists
let tunnelId;
try {
  const listOutput = execSync(`"${cfPath}" tunnel list`, { encoding: 'utf8' });
  const match = listOutput.match(/([a-f0-9-]{36})\s+cloudpipe/);
  if (match) {
    tunnelId = match[1];
    console.log('[OK] Tunnel "cloudpipe" exists:', tunnelId);
  }
} catch (e) {
  // Tunnel list failed, might need login
}

if (!tunnelId) {
  console.log('[*] Creating tunnel "cloudpipe"...');
  try {
    const output = execSync(`"${cfPath}" tunnel create cloudpipe`, { encoding: 'utf8' });
    const match = output.match(/([a-f0-9-]{36})/);
    if (match) {
      tunnelId = match[1];
      console.log('[OK] Created tunnel:', tunnelId);
    }
  } catch (e) {
    console.log('[!] Failed to create tunnel. Run: cloudflared tunnel login');
    process.exit(1);
  }
}

// Find credentials file
const credentialsFile = path.join(process.env.USERPROFILE, '.cloudflared', `${tunnelId}.json`);

// Generate ingress rules (deduplicate by subdomain)
const seenSubdomains = new Set();
const ingress = [];
services.forEach(s => {
  if (!seenSubdomains.has(s.subdomain)) {
    seenSubdomains.add(s.subdomain);
    ingress.push({
      hostname: `${s.subdomain}.${config.domain}`,
      service: `http://localhost:${s.port}`
    });
  }
});
ingress.push({ service: 'http_status:404' });

// Write YAML config
const yamlContent = `tunnel: cloudpipe
credentials-file: ${credentialsFile}

ingress:
${ingress.map(i => {
  if (i.hostname) {
    return `  - hostname: ${i.hostname}\n    service: ${i.service}`;
  } else {
    return `  - service: ${i.service}`;
  }
}).join('\n')}
`;

fs.writeFileSync(tunnelConfigPath, yamlContent);
console.log('[OK] Generated tunnel config:', tunnelConfigPath);

// Setup DNS routes
console.log('[*] Setting up DNS routes...');
services.forEach(s => {
  if (!seenSubdomains.has(s.subdomain + '_dns')) {
    seenSubdomains.add(s.subdomain + '_dns');
    const hostname = `${s.subdomain}.${config.domain}`;
    try {
      execSync(`"${cfPath}" tunnel route dns -f cloudpipe ${hostname}`, { encoding: 'utf8', stdio: 'pipe' });
      console.log(`[OK] DNS: ${hostname}`);
    } catch (e) {
      console.log(`[OK] DNS: ${hostname} (exists)`);
    }
  }
});

// Start tunnel
console.log('');
console.log('========================================');
console.log('  Starting Cloudflare Tunnel');
console.log('========================================');
console.log('');
console.log('Services:');
ingress.forEach(i => {
  if (i.hostname) {
    console.log(`  - https://${i.hostname} -> ${i.service}`);
  }
});
console.log('');
console.log('Press Ctrl+C to stop');
console.log('');

const tunnel = spawn(cfPath, ['tunnel', '--config', tunnelConfigPath, 'run', 'cloudpipe'], {
  stdio: 'inherit'
});

tunnel.on('close', (code) => {
  console.log('[*] Tunnel stopped');
  process.exit(code);
});
