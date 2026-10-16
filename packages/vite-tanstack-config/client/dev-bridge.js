// Browser side of the Seemodo dev server bridge. Served by the dev server as a
// virtual module (development only, never part of a production build) and
// loaded together with Vite's HMR client.
//
// - reports uncaught errors, unhandled rejections and failed resource loads to
//   the dev server's error collector (they end up in the dev server log, where
//   the Seemodo agent reads them),
// - forwards dev-server status events (restart, HMR gate, progress, server
//   errors) to the Seemodo editor with the same postMessage envelope as
//   /seemodo.js ({ type, payload, source: "seemodo-bridge" }),
// - runs code snippets sent through /__seemodo/preview-execute and returns the
//   result (only when the dev server enabled it).
//
// Plain ES2020 on purpose: the dev server serves this file without transpiling.
//
// Copyright (c) 2026 Seemodo. MIT License.

export function startSeemodoDevBridge(config) {
  const hot = import.meta.hot;
  const g = globalThis;
  if (!hot || typeof window === "undefined" || g.__seemodoDevBridge) return;
  const bridge = { viewerId: makeId(), handled: new Set() };
  g.__seemodoDevBridge = bridge;

  function makeId() {
    try {
      if (g.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
    } catch (_) {
      // insecure context
    }
    return "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function clip(value, max) {
    const text = value == null ? "" : String(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  // ---- viewer presence ----------------------------------------------------
  function hello() {
    try {
      hot.send("seemodo:viewer-hello", {
        viewerId: bridge.viewerId,
        url: clip(location.href, 2000),
        title: clip(document.title, 200),
        embedded: window.parent !== window,
      });
    } catch (_) {
      // socket not ready; the next navigation retries
    }
  }
  hello();
  hot.on("vite:ws:connect", hello);
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function () {
      const result = original.apply(this, arguments);
      setTimeout(hello, 0);
      return result;
    };
  }
  window.addEventListener("popstate", hello);

  // ---- editor forwarding ----------------------------------------------------
  function toEditor(type, payload) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage({ type: type, payload: payload, source: "seemodo-bridge" }, "*");
    } catch (_) {
      // parent gone
    }
  }
  hot.on("seemodo:dev-server-restarting", (data) => toEditor("DEV_SERVER_RESTARTING", data || {}));
  hot.on("seemodo:server-error", (data) => toEditor("SERVER_ERROR", data || {}));
  for (const event of [
    "seemodo:dev-server-mode",
    "seemodo:hmr-gate",
    "seemodo:boot-progress",
    "seemodo:update-progress",
  ]) {
    hot.on(event, (data) => toEditor("DEV_SERVER_STATUS", { event: event, data: data }));
  }

  // ---- error collector ------------------------------------------------------
  if (config.errorEndpoint) {
    const recent = new Map();
    let windowStart = Date.now();
    let sent = 0;
    const post = (report) => {
      const now = Date.now();
      if (now - windowStart > 10000) {
        windowStart = now;
        sent = 0;
      }
      const key = report.type + "|" + report.message;
      if (sent >= 20 || now - (recent.get(key) || 0) < 2000) return;
      recent.set(key, now);
      if (recent.size > 200) recent.clear();
      sent += 1;
      const body = JSON.stringify(
        Object.assign({}, report, {
          url: clip(location.href, 2000),
          userAgent: clip(navigator.userAgent, 300),
          viewerId: bridge.viewerId,
          time: new Date().toISOString(),
        }),
      );
      try {
        fetch(config.errorEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body,
          keepalive: body.length < 60000,
        }).catch(() => {});
      } catch (_) {
        // fetch unavailable
      }
    };
    const describe = (value, fallback) => {
      if (value && typeof value === "object") {
        const message = "message" in value ? clip(value.message, 4000) : "";
        const name = "name" in value ? clip(value.name, 200) : "";
        const stack = "stack" in value ? clip(value.stack, 8000) : "";
        if (message || stack)
          return {
            name: name || undefined,
            message: message || fallback,
            stack: stack || undefined,
          };
        try {
          return { message: clip(JSON.stringify(value), 4000) || fallback };
        } catch (_) {
          return { message: fallback };
        }
      }
      return { message: value == null || value === "" ? fallback : clip(value, 4000) };
    };
    window.addEventListener(
      "error",
      (event) => {
        const target = event.target;
        if (target && target !== window && target.tagName) {
          const tag = String(target.tagName).toLowerCase();
          const src = clip(target.currentSrc || target.src || target.href || "", 2000);
          post({
            type: "resource-error",
            message: "Failed to load <" + tag + ">" + (src ? " " + src : ""),
            tag: tag,
            resource: src || undefined,
          });
          return;
        }
        const info = describe(event.error || event.message, "Uncaught error");
        post(
          Object.assign({ type: "runtime-error" }, info, {
            file: clip(event.filename, 2000) || undefined,
            line: event.lineno || undefined,
            column: event.colno || undefined,
          }),
        );
      },
      true,
    );
    window.addEventListener("unhandledrejection", (event) => {
      post(
        Object.assign(
          { type: "unhandled-rejection" },
          describe(event.reason, "Unhandled promise rejection"),
        ),
      );
    });
  }

  // ---- preview execute ------------------------------------------------------
  if (config.execute) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const encode = (value) => {
      if (value === undefined) return { kind: "undefined" };
      const seen = new WeakSet();
      let text;
      try {
        text = JSON.stringify(value, (_key, item) => {
          if (typeof item === "bigint") return item.toString() + "n";
          if (typeof item === "function") return "[function " + (item.name || "anonymous") + "]";
          if (typeof Element !== "undefined" && item instanceof Element)
            return item.outerHTML.slice(0, 2000);
          if (item && typeof item === "object") {
            if (seen.has(item)) return "[circular]";
            seen.add(item);
          }
          return item;
        });
      } catch (error) {
        return { kind: "unserializable", text: clip(String(value), config.maxResultChars) };
      }
      if (text === undefined) return { kind: "undefined" };
      if (text.length > config.maxResultChars) {
        return {
          kind: "truncated",
          text: text.slice(0, config.maxResultChars),
          length: text.length,
        };
      }
      return { kind: "json", value: JSON.parse(text) };
    };
    // Run detached: Vite's client awaits listeners, and a slow snippet must not
    // hold back HMR messages queued behind it.
    hot.on("seemodo:preview-execute", (request) => {
      run(request);
    });
    const run = async (request) => {
      if (!request || typeof request.id !== "string" || typeof request.code !== "string") return;
      if (bridge.handled.has(request.id)) return;
      if (bridge.handled.size > 1000) bridge.handled.clear();
      bridge.handled.add(request.id);
      const started = performance.now();
      const reply = (fields) =>
        hot.send(
          "seemodo:preview-execute-result",
          Object.assign(
            {
              id: request.id,
              viewerId: bridge.viewerId,
              url: clip(location.href, 2000),
              durationMs: Math.round(performance.now() - started),
            },
            fields,
          ),
        );
      let timer;
      try {
        const run = new AsyncFunction(request.code)();
        const limit = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out in the page")),
            request.timeoutMs || 3000,
          );
        });
        const value = await Promise.race([run, limit]);
        reply({ ok: true, result: encode(value) });
      } catch (error) {
        reply({
          ok: false,
          error: {
            name: error && error.name ? clip(error.name, 200) : "Error",
            message: clip(error && error.message !== undefined ? error.message : error, 4000),
            stack: error && error.stack ? clip(error.stack, 8000) : undefined,
          },
        });
      } finally {
        clearTimeout(timer);
      }
    };
  }
}
