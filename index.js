const fs = require('fs');
const path = require('path');

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('');
console.log('========================================');
console.log('  CLOUDPIPE - API Tunnel Service');
console.log('========================================');
console.log('');

const enabledServices = config.services.filter(s => s.enabled);

if (enabledServices.length === 0) {
  console.log('[!] No services enabled in config.json');
  console.log('    Edit config.json and set "enabled": true');
  process.exit(1);
}

console.log(`[*] Starting ${enabledServices.length} service(s)...`);
console.log('');

const servers = [];

enabledServices.forEach(service => {
  try {
    let createServer;

    if (service.type === 'proxy') {
      createServer = require('./servers/proxy/server.js');
    } else if (service.type === 'custom') {
      const customPath = path.join(__dirname, service.entry);
      if (!fs.existsSync(customPath)) {
        console.log(`[!] ${service.name}: Entry file not found: ${service.entry}`);
        return;
      }
      createServer = require(customPath);
    } else {
      console.log(`[!] ${service.name}: Unknown type "${service.type}"`);
      return;
    }

    const server = createServer(service);
    server.listen(service.port, () => {
      console.log(`[OK] ${service.name}`);
      console.log(`     Type: ${service.type}`);
      console.log(`     Port: ${service.port}`);
      console.log(`     URL:  https://${service.subdomain}.${config.domain}`);
      if (service.type === 'proxy') {
        console.log(`     Target: ${service.target}`);
      }
      console.log('');
    });

    servers.push({ service, server });
  } catch (err) {
    console.log(`[!] ${service.name}: Failed to start - ${err.message}`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log('[*] Shutting down...');
  servers.forEach(({ service, server }) => {
    server.close();
    console.log(`[OK] ${service.name} stopped`);
  });
  process.exit(0);
});

console.log('----------------------------------------');
console.log('Press Ctrl+C to stop all services');
console.log('----------------------------------------');
console.log('');
