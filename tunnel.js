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

const enabledServices = config.services.filter(s => s.enabled);

if (enabledServices.length === 0) {
  console.log('[!] No services enabled');
  process.exit(1);
}

// Generate tunnel config
const tunnelConfigPath = path.join(__dirname, 'tunnels', 'cloudpipe-config.yml');

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

// Generate ingress rules
const ingress = enabledServices.map(s => ({
  hostname: `${s.subdomain}.${config.domain}`,
  service: `http://localhost:${s.port}`
}));
ingress.push({ service: 'http_status:404' });

const tunnelConfig = {
  tunnel: 'cloudpipe',
  'credentials-file': credentialsFile,
  ingress: ingress
};

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
enabledServices.forEach(s => {
  const hostname = `${s.subdomain}.${config.domain}`;
  try {
    execSync(`"${cfPath}" tunnel route dns -f cloudpipe ${hostname}`, { encoding: 'utf8', stdio: 'pipe' });
    console.log(`[OK] DNS: ${hostname}`);
  } catch (e) {
    // Might already exist, that's ok
    console.log(`[OK] DNS: ${hostname} (exists)`);
  }
});

// Start tunnel
console.log('');
console.log('========================================');
console.log('  Starting Cloudflare Tunnel');
console.log('========================================');
console.log('');
console.log('Services:');
enabledServices.forEach(s => {
  console.log(`  - https://${s.subdomain}.${config.domain} -> localhost:${s.port}`);
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
