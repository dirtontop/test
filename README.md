# Personal Web Proxy

This is an independent Node.js personal web-proxy project. It does not use Rammerhead.

## Run locally

Install Node.js 24 LTS or newer.

```bash
npm install
npm start
```

Then open:

http://localhost:10000

## Deploy

This project includes `render.yaml` for a Render Web Service.

The server binds to `0.0.0.0` and uses the `PORT` environment variable when provided.

## Important limitations

This is intentionally a small starting proxy. Modern sites that depend heavily on JavaScript, WebSockets, strict CSP, service workers, or complicated authentication can fail. A production-grade general browser proxy is substantially more complex.

Keep the service private/authenticated if you are deploying it publicly. Do not use it to bypass an organization’s access controls.
