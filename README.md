# Personal Web Proxy v2

A small, self-hosted browser-style HTTP/HTTPS proxy.

## Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free
- Root Directory: blank

The server binds to `0.0.0.0` and uses Render's `PORT` environment variable.

## Local

```bash
npm install
npm start
```

Then open `http://localhost:10000`.

## Important limitations

This is not a full Chromium-level proxy. Modern sites may use WebSockets, service workers, complex JavaScript, certificate/security assumptions, anti-bot systems, or APIs that cannot be transparently proxied by a simple application like this.

Roblox in particular may not function fully through it even after these improvements.

Because a general-purpose proxy can be abused, keep the service private or add authentication before sharing the URL publicly.
