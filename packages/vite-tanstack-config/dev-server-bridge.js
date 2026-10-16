// Dev server bridge: endpoints that connect the running Vite dev server with
// the Seemodo sandbox (control server, agent) and the preview tabs.
//
//   POST /__seemodo/error-collector    browser error reports (any page of the app)
//   POST /__seemodo/restart-announce   tell preview tabs the dev server restarts   [control]
//   POST /__seemodo/preview-execute    run a snippet in every preview tab          [control, sandbox]
//   GET  /__seemodo/viewers            connected preview tabs                      [control]
//
// [control] endpoints accept only direct loopback requests from inside the
// sandbox, or requests carrying SEEMODO_DEV_BRIDGE_TOKEN (see lib/http.js).
//
// Copyright (c) 2026 Seemodo. MIT License.

import { readFileSync } from "node:fs";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject, isTrustedControlRequest, readJson, sendJson } from "./lib/http.js";
import { onErrorReport, writeErrorReport } from "./lib/report.js";
import { clampNumber, clipText, isSeemodoSandbox, pathnameOf } from "./lib/sandbox.js";

export const ERROR_COLLECTOR_PATH = "/__seemodo/error-collector";
export const RESTART_ANNOUNCE_PATH = "/__seemodo/restart-announce";
export const PREVIEW_EXECUTE_PATH = "/__seemodo/preview-execute";
export const VIEWERS_PATH = "/__seemodo/viewers";

export const RESTART_EVENT = "seemodo:dev-server-restarting";
export const SERVER_ERROR_EVENT = "seemodo:server-error";
export const PREVIEW_EXECUTE_EVENT = "seemodo:preview-execute";
export const PREVIEW_EXECUTE_RESULT_EVENT = "seemodo:preview-execute-result";
export const VIEWER_HELLO_EVENT = "seemodo:viewer-hello";

export const DEFAULT_ERROR_LOG = ".seemodo/dev-errors.jsonl";
export const DEFAULT_ERROR_BODY_LIMIT = 16 * 1024;
const ERROR_LOG_MAX_BYTES = 2 * 1024 * 1024;
const ERRORS_PER_MINUTE = 120;

const EXECUTE_BODY_LIMIT = 64 * 1024;
const EXECUTE_CODE_LIMIT = 32 * 1024;
const EXECUTE_DEFAULT_TIMEOUT_MS = 3_000;
const EXECUTE_MAX_TIMEOUT_MS = 15_000;
const EXECUTE_MAX_IN_FLIGHT = 4;
const EXECUTE_RESULT_CHARS = 16 * 1024;

const CLIENT_MODULE_ID = "virtual:seemodo-dev-bridge";
const RESOLVED_CLIENT_MODULE_ID = `\0${CLIENT_MODULE_ID}`;
const CLIENT_SOURCE_FILE = fileURLToPath(new URL("./client/dev-bridge.js", import.meta.url));

function isViteClient(id) {
  return id.replaceAll("\\", "/").includes("/vite/dist/client/client.mjs");
}

// ---------------------------------------------------------------------------
// Error collector
// ---------------------------------------------------------------------------

const REPORT_FIELDS = {
  type: 60,
  name: 200,
  message: 4000,
  stack: 8000,
  file: 2000,
  tag: 40,
  resource: 2000,
  url: 2000,
  userAgent: 300,
  viewerId: 80,
  time: 40,
};

/** Normalizes a browser report: known fields only, strings clipped, numbers kept. */
export function normalizeBrowserReport(input) {
  const report = { source: "browser" };
  for (const [key, max] of Object.entries(REPORT_FIELDS)) {
    const value = input[key];
    if (typeof value === "string" && value !== "") report[key] = clipText(value, max);
  }
  for (const key of ["line", "column"]) {
    if (Number.isInteger(input[key]) && input[key] >= 0) report[key] = input[key];
  }
  report.type ??= "runtime-error";
  report.message ??= "(no message)";
  if (!report.time) report.time = new Date().toISOString();
  report.receivedAt = new Date().toISOString();
  return report;
}

/**
 * Creates the collector: an HTTP handler plus the log file appender.
 * Options: `endpoint`, `outputFile` (relative to root), `maxBodyBytes`, `resetOnStart`.
 */
export function createErrorCollector(options = {}) {
  const endpoint = options.endpoint ?? ERROR_COLLECTOR_PATH;
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || /[?#]/.test(endpoint)) {
    throw new Error(`errorCollector.endpoint must be a path such as ${ERROR_COLLECTOR_PATH}`);
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_ERROR_BODY_LIMIT;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("errorCollector.maxBodyBytes must be a positive integer");
  }
  const outputFile = options.outputFile === undefined ? DEFAULT_ERROR_LOG : options.outputFile;
  const perMinute = options.maxReportsPerMinute ?? ERRORS_PER_MINUTE;

  let file;
  let ready = Promise.resolve();
  let queue = Promise.resolve();
  let windowStart = 0;
  let inWindow = 0;
  let dropped = 0;

  const append = (line) => {
    if (!file) return Promise.resolve();
    const task = queue.then(async () => {
      await ready;
      const size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
      if (size > ERROR_LOG_MAX_BYTES) await writeFile(file, "");
      await appendFile(file, line);
    });
    queue = task.catch(() => {});
    return task;
  };

  return {
    endpoint,
    /** Sets the project root; creates (and by default empties) the log file. */
    start(root) {
      if (!outputFile) return;
      file = path.resolve(root, outputFile);
      ready = mkdir(path.dirname(file), { recursive: true })
        .then(() => (options.resetOnStart === false ? undefined : writeFile(file, "")))
        .catch(() => {});
    },
    get file() {
      return file;
    },
    /** Records one report: `[seemodo:error]` on stderr and a JSON line in the log file. */
    record(input) {
      const report = normalizeBrowserReport(input);
      writeErrorReport(report);
      return append(`${JSON.stringify(report)}\n`).then(() => report);
    },
    async handle(req, res) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        if (dropped > 0) {
          writeErrorReport({
            source: "browser",
            type: "dropped",
            message: `${dropped} browser error report(s) dropped (rate limit)`,
            time: new Date().toISOString(),
          });
        }
        windowStart = now;
        inWindow = 0;
        dropped = 0;
      }
      if (inWindow >= perMinute) {
        dropped += 1;
        req.resume();
        return sendJson(res, 429, { error: "rate_limited" });
      }
      const body = await readJson(req, maxBodyBytes);
      if (!body.ok) return sendJson(res, body.status, { error: body.error });
      if (!isPlainObject(body.value))
        return sendJson(res, 400, { error: "body_must_be_an_object" });
      inWindow += 1;
      try {
        await this.record(body.value);
      } catch {
        return sendJson(res, 500, { error: "write_failed" });
      }
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Preview execute
// ---------------------------------------------------------------------------

export function parseExecuteRequest(value) {
  if (!isPlainObject(value)) return { error: "body must be a JSON object" };
  const { code } = value;
  if (typeof code !== "string" || code.trim() === "")
    return { error: "code must be a non-empty string" };
  if (code.length > EXECUTE_CODE_LIMIT)
    return { error: `code is limited to ${EXECUTE_CODE_LIMIT} characters` };
  const timeoutMs = clampNumber(
    value.timeoutMs ?? value.timeout_ms,
    100,
    EXECUTE_MAX_TIMEOUT_MS,
    EXECUTE_DEFAULT_TIMEOUT_MS,
  );
  return { code, timeoutMs };
}

function boundedResult(result) {
  const text = JSON.stringify(result);
  if (text.length <= EXECUTE_RESULT_CHARS * 2) return result;
  return { ...result, result: { kind: "truncated", length: text.length } };
}

let executeSeq = 0;

/**
 * Sends `code` to every connected preview client and waits until all of them
 * answered or `timeoutMs` passed.
 */
export function executeInViewers(ws, pending, { code, timeoutMs }) {
  executeSeq += 1;
  const id = `exec-${Date.now().toString(36)}-${executeSeq}`;
  const expected = ws.clients?.size ?? 0;
  if (expected === 0) {
    return Promise.resolve({ id, viewers: 0, responded: 0, timedOut: 0, results: [] });
  }
  return new Promise((resolve) => {
    const results = new Map();
    let timer;
    const finish = () => {
      clearTimeout(timer);
      pending.delete(id);
      resolve({
        id,
        viewers: expected,
        responded: results.size,
        timedOut: Math.max(0, expected - results.size),
        results: [...results.values()],
      });
    };
    pending.set(id, (key, result) => {
      results.set(key, boundedResult(result));
      if (results.size >= expected) finish();
    });
    // The page enforces timeoutMs itself; the extra second covers the round trip.
    timer = setTimeout(finish, timeoutMs + 1000);
    timer.unref?.();
    ws.send({ type: "custom", event: PREVIEW_EXECUTE_EVENT, data: { id, code, timeoutMs } });
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const FORWARDED_SOURCES = new Set(["ssr", "http", "server-fn", "vite", "process", "console"]);

/**
 * Options:
 * - `errorCollector`: `false` or `{ endpoint, outputFile, maxBodyBytes, resetOnStart, maxReportsPerMinute }`
 * - `restartAnnounce`: default `true`
 * - `previewExecute`: default `true` inside a Seemodo sandbox, `false` elsewhere
 * - `forwardServerErrors`: send server-side `[seemodo:error]` reports to preview tabs (default `true`)
 * - `token`: shared secret for control endpoints (default `SEEMODO_DEV_BRIDGE_TOKEN`)
 */
export function devServerBridgePlugin(options = {}) {
  const collector =
    options.errorCollector === false ? undefined : createErrorCollector(options.errorCollector);
  const restartAnnounce = options.restartAnnounce !== false;
  const previewExecute = options.previewExecute ?? isSeemodoSandbox();
  const forwardServerErrors = options.forwardServerErrors !== false;
  const token = options.token ?? process.env.SEEMODO_DEV_BRIDGE_TOKEN ?? "";
  let unsubscribe;

  const clientConfig = {
    errorEndpoint: collector?.endpoint ?? null,
    execute: previewExecute,
    maxResultChars: EXECUTE_RESULT_CHARS,
  };

  return {
    name: "seemodo:dev-server-bridge",
    apply: "serve",

    configResolved(config) {
      collector?.start(config.root);
    },

    configureServer(server) {
      const ws = server.ws;
      const viewers = new Map(); // client -> info
      const pendingExecutions = new Map();
      let connections = 0;
      let inFlight = 0;

      ws.on?.("vite:client:connect", () => {
        connections += 1;
      });
      ws.on?.("vite:client:disconnect", (_data, client) => viewers.delete(client));
      ws.on?.(VIEWER_HELLO_EVENT, (data, client) => {
        if (!isPlainObject(data) || !client) return;
        const previous = viewers.get(client);
        viewers.set(client, {
          viewerId: clipText(String(data.viewerId ?? ""), 80),
          url: clipText(String(data.url ?? ""), 2000),
          title: clipText(String(data.title ?? ""), 200),
          embedded: data.embedded === true,
          connectedAt: previous?.connectedAt ?? new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
      });
      ws.on?.(PREVIEW_EXECUTE_RESULT_EVENT, (data, client) => {
        if (!isPlainObject(data) || typeof data.id !== "string") return;
        const collect = pendingExecutions.get(data.id);
        if (!collect) return;
        collect(client ?? data.viewerId, {
          viewerId: typeof data.viewerId === "string" ? data.viewerId : null,
          url: typeof data.url === "string" ? data.url : null,
          ok: data.ok === true,
          durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
          ...(data.ok === true ? { result: data.result } : { error: data.error ?? null }),
        });
      });

      if (forwardServerErrors) {
        let last = { key: "", at: 0 };
        unsubscribe?.();
        unsubscribe = onErrorReport((report) => {
          if (!FORWARDED_SOURCES.has(report.source)) return;
          const key = `${report.source}|${report.message}`;
          const now = Date.now();
          if (key === last.key && now - last.at < 1000) return;
          last = { key, at: now };
          try {
            ws.send({
              type: "custom",
              event: SERVER_ERROR_EVENT,
              data: {
                source: report.source,
                message: clipText(report.message, 2000),
                stack: clipText(report.stack, 4000),
                file: report.file,
                url: report.url,
                status: report.status,
                time: report.time,
              },
            });
          } catch {
            // no clients
          }
        });
      }

      const control = (req, res) => {
        if (isTrustedControlRequest(req, token)) return true;
        sendJson(res, 403, { error: "forbidden" });
        return false;
      };

      server.middlewares.use((req, res, next) => {
        const route = pathnameOf(req);

        if (collector && route === collector.endpoint) {
          collector.handle(req, res).catch(() => sendJson(res, 500, { error: "internal" }));
          return;
        }

        if (route === VIEWERS_PATH) {
          if (!control(req, res)) return;
          const open = ws.clients ?? new Set();
          for (const client of viewers.keys()) if (!open.has(client)) viewers.delete(client);
          sendJson(res, 200, {
            count: open.size,
            connections,
            previewExecute,
            viewers: [...viewers.values()],
          });
          return;
        }

        if (route === RESTART_ANNOUNCE_PATH && restartAnnounce) {
          if (!control(req, res)) return;
          if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
          readJson(req, 1024, { allowEmpty: true }).then((body) => {
            if (!body.ok) return sendJson(res, body.status, { error: body.error });
            const reason =
              isPlainObject(body.value) && typeof body.value.reason === "string"
                ? body.value.reason.slice(0, 200)
                : undefined;
            const data = { reason: reason ?? null, at: new Date().toISOString() };
            ws.send({ type: "custom", event: RESTART_EVENT, data });
            sendJson(res, 200, { announced: true, viewers: ws.clients?.size ?? 0, ...data });
          });
          return;
        }

        if (route === PREVIEW_EXECUTE_PATH) {
          if (!previewExecute) return sendJson(res, 404, { error: "preview_execute_disabled" });
          if (!control(req, res)) return;
          if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
          if (inFlight >= EXECUTE_MAX_IN_FLIGHT) {
            req.resume();
            return sendJson(res, 429, { error: "too_many_executions" });
          }
          inFlight += 1;
          readJson(req, EXECUTE_BODY_LIMIT)
            .then(async (body) => {
              if (!body.ok) return sendJson(res, body.status, { error: body.error });
              const parsed = parseExecuteRequest(body.value);
              if (parsed.error) return sendJson(res, 400, { error: parsed.error });
              sendJson(res, 200, await executeInViewers(ws, pendingExecutions, parsed));
              return undefined;
            })
            .catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
            .finally(() => {
              inFlight -= 1;
            });
          return;
        }

        next();
      });
    },

    resolveId(id) {
      return id === CLIENT_MODULE_ID ? RESOLVED_CLIENT_MODULE_ID : undefined;
    },

    load(id) {
      if (id !== RESOLVED_CLIENT_MODULE_ID) return undefined;
      const source = readFileSync(CLIENT_SOURCE_FILE, "utf8");
      return `${source}\nstartSeemodoDevBridge(${JSON.stringify(clientConfig)});\n`;
    },

    transform(code, id, transformOptions) {
      if (transformOptions?.ssr || this.environment?.config?.consumer === "server")
        return undefined;
      if (!isViteClient(id)) return undefined;
      // Dynamic, so it runs after Vite's client finished initializing (the bridge
      // module itself imports createHotContext from that client).
      return {
        code: `${code}\nimport(${JSON.stringify(CLIENT_MODULE_ID)}).catch(() => {});\n`,
        map: null,
      };
    },

    closeWatcher() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

export default devServerBridgePlugin;
