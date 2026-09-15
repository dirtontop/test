import express from "express";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import cookieParser from "cookie-parser";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(express.static("public", { index: "index.html" }));

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host",
  "content-length"
]);

function normalizeTarget(raw) {
  if (!raw) throw new Error("Missing url");
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }
  return u;
}

function proxiedUrl(target, base = null) {
  try {
    const absolute = new URL(target, base || undefined);
    if (!["http:", "https:"].includes(absolute.protocol)) return target;
    return "/proxy?url=" + encodeURIComponent(absolute.toString());
  } catch {
    return target;
  }
}

function rewriteHtml(html, targetUrl) {
  // Rewrite common URL-bearing HTML attributes.
  html = html.replace(
    /(\b(?:href|src|action|poster|formaction)\s*=\s*)(["'])([^"']+)\2/gi,
    (_, prefix, quote, value) => {
      if (/^(?:#|data:|javascript:|mailto:|tel:|blob:)/i.test(value)) return _;
      return `${prefix}${quote}${proxiedUrl(value, targetUrl)}${quote}`;
    }
  );

  // Rewrite srcset candidates.
  html = html.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi,
    (_, prefix, quote, value) => {
      const rewritten = value.split(",").map(part => {
        const pieces = part.trim().split(/\s+/);
        if (!pieces[0] || /^(?:data:|blob:)/i.test(pieces[0])) return part;
        pieces[0] = proxiedUrl(pieces[0], targetUrl);
        return pieces.join(" ");
      }).join(", ");
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );

  // Rewrite CSS url(...) references inside inline styles.
  html = html.replace(
    /url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (_, quote, value) => {
      if (/^(?:data:|blob:|#)/i.test(value.trim())) return _;
      return `url("${proxiedUrl(value.trim(), targetUrl)}")`;
    }
  );

  // Rewrite common absolute/relative URLs in meta refresh.
  html = html.replace(
    /(<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=)([^"'>]+)/gi,
    (_, prefix, value) => `${prefix}${proxiedUrl(value, targetUrl)}`
  );

  // Inject a base marker so relative JS URL construction has a better chance
  // of remaining on the proxied page.
  if (/<head[\s>]/i.test(html) && !/<base\s/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${targetUrl.toString().replace(/"/g, "&quot;")}">`);
  }

  return html;
}

function buildHeaders(req, target) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "accept-encoding") continue;
    if (key.toLowerCase() === "cookie") continue;
    headers[key] = value;
  }

  // Send only cookies stored for this browser session.
  if (req.headers.cookie) headers.cookie = req.headers.cookie;

  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = req.protocol;
  return headers;
}

function copyResponseHeaders(proxyRes, res) {
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;

    if (lower === "location") {
      try {
        const absolute = new URL(value, proxyRes.req?.res?.responseUrl || undefined);
        res.setHeader("location", "/proxy?url=" + encodeURIComponent(absolute.toString()));
      } catch {
        res.setHeader("location", value);
      }
      continue;
    }

    // Cookies set by the target are passed through. The browser will associate
    // them with the proxy origin, allowing subsequent proxied requests to send them.
    if (lower === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      const rewritten = cookies.map(c =>
        c.replace(/;\s*Domain=[^;]+/ig, "")
         .replace(/;\s*SameSite=None/ig, "; SameSite=Lax")
      );
      res.setHeader("set-cookie", rewritten);
      continue;
    }

    // These policies commonly prevent a proxied page from embedding its own
    // assets or being framed.
    if (lower === "content-security-policy" ||
        lower === "content-security-policy-report-only" ||
        lower === "x-frame-options") {
      continue;
    }

    res.setHeader(key, value);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "personal-web-proxy", version: "2.0.0" });
});

app.all("/proxy", async (req, res) => {
  let target;
  try {
    target = normalizeTarget(req.query.url);
  } catch (err) {
    return res.status(400).send(`Bad URL: ${err.message}`);
  }

  const client = target.protocol === "https:" ? https : http;

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers: buildHeaders(req, target),
    timeout: 30000,
    servername: target.hostname
  };

  const upstream = client.request(options, proxyRes => {
    const status = proxyRes.statusCode || 502;

    // Redirects need to stay inside the proxy.
    if (status >= 300 && status < 400 && proxyRes.headers.location) {
      let destination;
      try {
        destination = new URL(proxyRes.headers.location, target).toString();
      } catch {
        destination = proxyRes.headers.location;
      }
      copyResponseHeaders(proxyRes, res);
      res.statusCode = status;
      res.setHeader("location", proxiedUrl(destination));
      proxyRes.resume();
      return;
    }

    const contentType = String(proxyRes.headers["content-type"] || "").toLowerCase();
    copyResponseHeaders(proxyRes, res);
    res.statusCode = status;

    if (contentType.includes("text/html")) {
      const chunks = [];
      proxyRes.on("data", chunk => chunks.push(chunk));
      proxyRes.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const rewritten = rewriteHtml(body, target.toString());
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("content-length", Buffer.byteLength(rewritten));
        res.end(rewritten);
      });
    } else {
      proxyRes.pipe(res);
    }
  });

  upstream.on("timeout", () => upstream.destroy(new Error("Upstream timeout")));
  upstream.on("error", err => {
    if (!res.headersSent) {
      res.status(502).send(`Proxy error: ${err.message}`);
    } else {
      res.end();
    }
  });

  if (!["GET", "HEAD"].includes(req.method)) {
    req.pipe(upstream);
  } else {
    upstream.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).send("Internal server error");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Personal web proxy listening on 0.0.0.0:${PORT}`);
});
