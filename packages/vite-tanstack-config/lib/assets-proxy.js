// Optional dev-only proxy for a platform-hosted asset path.
//
// Off unless BOTH variables are set:
//   SEEMODO_PREVIEW_HOST  host (and optional :port) of the HTTPS preview origin, no scheme
//   SEEMODO_ASSETS_PATH   path prefix to forward, e.g. "/__seemodo/assets/"
//
// Requests under the prefix are forwarded to https://<SEEMODO_PREVIEW_HOST><same path>,
// so assets that only exist on the preview origin also load when the page is
// opened straight from the dev server. Cookies and hop-by-hop headers are not
// forwarded.
//
// Copyright (c) 2026 Seemodo. MIT License.

import https from "node:https";
import { LOG_TAG } from "./sandbox.js";

export const PREVIEW_HOST_ENV = "SEEMODO_PREVIEW_HOST";
export const ASSETS_PATH_ENV = "SEEMODO_ASSETS_PATH";

const DROPPED_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardable(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined && !DROPPED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * Validates the two variables. Returns `{ host, port, prefix }` or `undefined`
 * (with a reason in `error` when the variables are set but unusable).
 */
export function resolveAssetsProxy(env = process.env) {
  const rawHost = env[PREVIEW_HOST_ENV]?.trim();
  const rawPrefix = env[ASSETS_PATH_ENV]?.trim();
  if (!rawHost || !rawPrefix) return { config: undefined };
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(rawHost);
  if (!match) {
    return {
      config: undefined,
      error: `${PREVIEW_HOST_ENV} must be a host name (no scheme or path)`,
    };
  }
  if (!rawPrefix.startsWith("/") || rawPrefix.startsWith("//") || /[?#]/.test(rawPrefix)) {
    return {
      config: undefined,
      error: `${ASSETS_PATH_ENV} must be a path such as /__seemodo/assets/`,
    };
  }
  const prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
  const port = match[2] ? Number(match[2]) : 443;
  return { config: { host: match[1], port, prefix } };
}

export function assetsProxyPlugin(env = process.env) {
  return {
    name: "seemodo:assets-proxy",
    apply: "serve",
    configureServer(server) {
      const { config, error } = resolveAssetsProxy(env);
      if (error) server.config.logger.warn(`${LOG_TAG} assets proxy disabled: ${error}.`);
      if (!config) return;
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(config.prefix)) return next();
        const upstream = https.request(
          {
            host: config.host,
            port: config.port,
            method: req.method,
            path: url,
            headers: { ...forwardable(req.headers), host: config.host },
          },
          (answer) => {
            res.statusCode = answer.statusCode ?? 502;
            for (const [name, value] of Object.entries(forwardable(answer.headers))) {
              res.setHeader(name, value);
            }
            answer.pipe(res);
          },
        );
        upstream.setTimeout(30_000, () => upstream.destroy(new Error("timed out")));
        upstream.on("error", (err) => {
          server.config.logger.warn(`${LOG_TAG} assets proxy ${url}: ${err.message}`);
          if (res.headersSent) res.destroy(err);
          else {
            res.statusCode = 502;
            res.end();
          }
        });
        req.pipe(upstream);
      });
    },
  };
}
