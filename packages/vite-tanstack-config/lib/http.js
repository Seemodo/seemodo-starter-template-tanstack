// Tiny HTTP helpers for the dev-server endpoints.
// Copyright (c) 2026 Seemodo. MIT License.

import { timingSafeEqual } from "node:crypto";

/**
 * Reads a JSON request body of at most `limit` bytes.
 * Resolves to `{ ok: true, value }` or `{ ok: false, status, error }`; never rejects.
 * An empty body resolves to `{ ok: true, value: undefined }` when `allowEmpty` is set.
 */
export function readJson(req, limit, { allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume?.();
      resolve({ ok: false, status: 413, error: "body_too_large" });
      return;
    }
    const parts = [];
    let size = 0;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    req.on("data", (chunk) => {
      if (finished) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        parts.length = 0;
        finish({ ok: false, status: 413, error: "body_too_large" });
        return;
      }
      parts.push(buf);
    });
    req.on("error", () => finish({ ok: false, status: 400, error: "read_failed" }));
    req.on("end", () => {
      if (finished) return;
      const text = Buffer.concat(parts).toString("utf8").trim();
      if (text === "") {
        finish(
          allowEmpty
            ? { ok: true, value: undefined }
            : { ok: false, status: 400, error: "empty_body" },
        );
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, status: 400, error: "invalid_json" });
      }
    });
  });
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const FORWARD_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

function tokensMatch(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decides whether a request may use a control endpoint (pause HMR, run code in
 * preview tabs, announce restarts).
 *
 * - With a token (`SEEMODO_DEV_BRIDGE_TOKEN`): the request must send it as
 *   `Authorization: Bearer <token>` or `x-seemodo-token: <token>`.
 * - Without a token: only direct loopback requests are accepted (the sandbox
 *   control server calls `http://127.0.0.1:<port>`); anything that came through
 *   a proxy (forwarding headers) or from a browser page (`Origin`) is refused.
 */
export function isTrustedControlRequest(req, token) {
  const headers = req.headers ?? {};
  if (token) {
    const auth = typeof headers.authorization === "string" ? headers.authorization : "";
    const given = auth.startsWith("Bearer ")
      ? auth.slice(7)
      : typeof headers["x-seemodo-token"] === "string"
        ? headers["x-seemodo-token"]
        : "";
    return given !== "" && tokensMatch(given, token);
  }
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? "")) return false;
  if (FORWARD_HEADERS.some((name) => headers[name] !== undefined)) return false;
  // Browsers mark every fetch with Origin (non-GET) or Sec-Fetch-* headers.
  return (
    headers.origin === undefined &&
    headers["sec-fetch-site"] === undefined &&
    headers["sec-fetch-mode"] === undefined
  );
}
