# Cloudpipe

Quick API tunnel service using Cloudflare Tunnel.

## Setup

1. Install cloudflared:
   ```
   winget install Cloudflare.cloudflared
   ```

2. Login to Cloudflare:
   ```
   cloudflared tunnel login
   ```

3. Edit `config.json` to add your services

4. Run `start.bat`

## Config Example

```json
{
  "domain": "yourdomain.com",
  "services": [
    {
      "name": "my-proxy",
      "enabled": true,
      "type": "proxy",
      "target": "https://api.example.com",
      "subdomain": "api",
      "port": 8787
    }
  ]
}
```

## Service Types

### proxy
Forward requests to another API with CORS support.

### custom
Run your own Node.js server. Copy `servers/custom/example.js` as template.

## Usage

```
start.bat       - Start all enabled services + tunnel
add-service.bat - Help for adding new services
```
