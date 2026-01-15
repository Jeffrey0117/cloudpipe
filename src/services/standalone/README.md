# Standalone Services

This directory is for **advanced standalone services** that need their own independent tunnel configuration.

## When to Use Standalone Mode

Use standalone mode when you need:
- Multiple subdomains for one service
- Custom ingress rules
- Services that don't fit the simple "drop a .js file" pattern

## How It Works

1. Create a folder here with your service name
2. Add your service's `server.js` and any other files
3. Add an entry to `config.json` under `standalone`:

```json
{
  "standalone": [
    {
      "name": "my-complex-service",
      "entry": "standalone/my-complex-service/server.js",
      "port": 8800,
      "subdomain": "complex"
    }
  ]
}
```

## Note

For 80% of use cases, you should just drop a `.js` file in the root `services/` directory.
Only use standalone mode when you need more control.
