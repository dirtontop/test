import express from "express";
import http from "http";
import https from "https";
import { URL } from "url";

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 10000;
const host = "0.0.0.0";

app.disable("x-powered-by");
app.use(express.static("public"));

function normalizeTarget(value) {
  if (!value) throw new Error("Missing URL");
  let target = value.trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  return url;
}

function hopByHopHeaders(headers) {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "host"
  ]);
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function rewriteHtml(body, target) {
  const base = target.href;
  let html = body.toString("utf8");

  // Basic URL rewriting for ordinary links/resources. Complex applications
  // may still need a browser-side proxy architecture.
  html = html.replace(
    /(href|src|action)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attr, quoted, dq, sq) => {
      const raw = dq ?? sq;
      if (!raw || raw.startsWith("#") || /^(data:|javascript:|mailto:|tel:)/i.test(raw)) {
        return match;
      }
      try {
        const absolute = new URL(raw, base).href;
        const proxied = "/proxy?url=" + encodeURIComponent(absolute);
        const q = quoted[0];
        return `${attr}=${q}${proxied}${q}`;
      } catch {
        return match;
      }
    }
  );

  return html;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/proxy", async (req, res) => {
  try {
    const target = normalizeTarget(req.query.url);
    const client = target.protocol === "https:" ? https : http;

    const headers = hopByHopHeaders(req.headers);
    headers["accept-encoding"] = "identity";

    const request = client.get(target, { headers }, (upstream) => {
      const responseHeaders = hopByHopHeaders(upstream.headers);

      // Cookies from the target are exposed to this personal proxy's browser
      // as normal response metadata where possible.
      if (responseHeaders.location) {
        try {
          responseHeaders.location = new URL(responseHeaders.location, target.href).href;
        } catch {}
      }

      const contentType = String(responseHeaders["content-type"] || "").toLowerCase();
      const chunks = [];

      upstream.on("data", chunk => chunks.push(chunk));
      upstream.on("end", () => {
        const body = Buffer.concat(chunks);

        if (contentType.includes("text/html")) {
          const rewritten = rewriteHtml(body, target);
          delete responseHeaders["content-length"];
          responseHeaders["content-type"] = "text/html; charset=utf-8";
          res.writeHead(upstream.statusCode || 200, responseHeaders);
          res.end(rewritten);
        } else {
          res.writeHead(upstream.statusCode || 200, responseHeaders);
          res.end(body);
        }
      });
    });

    request.setTimeout(30000, () => request.destroy(new Error("Upstream timeout")));
    request.on("error", err => {
      if (!res.headersSent) {
        res.status(502).type("text/plain").send("Proxy error: " + err.message);
      } else {
        res.destroy();
      }
    });
  } catch (err) {
    res.status(400).type("text/plain").send(err.message);
  }
});

server.listen(port, host, () => {
  console.log(`Personal proxy listening on http://${host}:${port}`);
});
