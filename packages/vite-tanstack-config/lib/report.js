// Structured `[seemodo:error] {json}` lines on stderr, plus the dev/build error logger.
// Copyright (c) 2026 Seemodo. MIT License.

import { clipText, stripAnsi } from "./sandbox.js";

export const ERROR_PREFIX = "[seemodo:error]";

const MAX_FIELD = 8000;

function describe(error) {
  if (error instanceof Error) {
    const loc = error.loc ?? undefined;
    return {
      name: error.name,
      message: stripAnsi(error.message),
      stack: stripAnsi(error.stack),
      file: error.id ?? error.file ?? loc?.file,
      line: loc?.line,
      column: loc?.column,
      plugin: error.plugin,
      frame: stripAnsi(error.frame),
    };
  }
  if (typeof error === "string") return { message: stripAnsi(error) };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

let reportCount = 0;
const subscribers = new Set();

/** Number of reports written so far (used to avoid double-reporting a 5xx). */
export function reportsWritten() {
  return reportCount;
}

/**
 * Registers a callback that receives every report (after it was written).
 * Returns an unsubscribe function. Used by the dev server bridge to forward
 * server errors to connected preview tabs.
 */
export function onErrorReport(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Builds the report payload without writing it. */
export function buildErrorReport(source, error, extra = {}) {
  const payload = { source, ...describe(error), ...extra, time: new Date().toISOString() };
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value === undefined || value === null || value === "") delete payload[key];
    else payload[key] = clipText(value, MAX_FIELD);
  }
  if (typeof payload.message !== "string") payload.message = String(payload.message ?? "");
  return payload;
}

/** Writes one already-built payload as a `[seemodo:error]` line. */
export function writeErrorReport(payload) {
  reportCount += 1;
  try {
    process.stderr.write(`${ERROR_PREFIX} ${JSON.stringify(payload)}\n`);
  } catch {
    // stderr closed: nothing useful left to do
  }
  for (const listener of subscribers) {
    try {
      listener(payload);
    } catch {
      // a broken subscriber must never break error reporting
    }
  }
  return payload;
}

/**
 * Writes one line to stderr: `[seemodo:error] {"source":...,"message":...}`.
 * The payload is single-line JSON so the sandbox control server can parse it.
 */
export function reportError(source, error, extra = {}) {
  return writeErrorReport(buildErrorReport(source, error, extra));
}

export function errorLoggerPlugin() {
  let processHooksInstalled = false;
  // Most recent string-only console.error output, so a 5xx can be reported
  // with its cause (the template's error-capture expands Errors to strings).
  let lastConsoleError;

  return {
    name: "seemodo:error-logger",

    configureServer(server) {
      // 1. Everything Vite itself logs as an error (transform, pre-transform,
      //    dependency optimizer, HMR update failures, config reload, ...).
      const logger = server.config.logger;
      const originalLoggerError = logger.error.bind(logger);
      logger.error = (msg, options) => {
        reportError("vite", options?.error ?? msg);
        originalLoggerError(msg, options);
      };

      // 2. SSR render failures that reach TanStack Start's dev middleware: it
      //    always calls ssrFixStacktrace(e) before rendering the error overlay.
      const originalFix = server.ssrFixStacktrace.bind(server);
      server.ssrFixStacktrace = (error) => {
        originalFix(error);
        reportError("ssr", error);
      };

      // 3. console.error: Error objects (route generator, plugins, server code)
      //    are reported right away; plain strings are kept as context for a 5xx.
      const originalConsoleError = console.error;
      console.error = (...args) => {
        const error = args.find((a) => a instanceof Error);
        if (error) {
          reportError("console", error);
        } else if (args.length > 0) {
          lastConsoleError = { message: args.map(String).join(" "), at: Date.now() };
        }
        originalConsoleError.apply(console, args);
      };

      // 4. Any 5xx answered by the dev server (pages and server functions),
      //    unless the failure was already reported while handling the request.
      server.middlewares.use((req, res, next) => {
        const url = req.originalUrl ?? req.url;
        const countAtStart = reportCount;
        res.on("finish", () => {
          if (res.statusCode < 500) return;
          const recent =
            lastConsoleError && Date.now() - lastConsoleError.at < 5000
              ? lastConsoleError
              : undefined;
          lastConsoleError = undefined;
          if (reportCount !== countAtStart) return;
          reportError(
            url?.includes("/_serverFn/") ? "server-fn" : "http",
            recent?.message ?? `HTTP ${res.statusCode}`,
            { method: req.method, url, status: res.statusCode },
          );
        });
        next();
      });

      // 5. Stray failures in server code. The exception monitor never changes
      //    Node's crash behavior; the rejection handler keeps the dev server
      //    alive and logs instead of exiting.
      if (!processHooksInstalled) {
        processHooksInstalled = true;
        process.on("uncaughtExceptionMonitor", (error) => reportError("process", error));
        process.on("unhandledRejection", (reason) => reportError("process", reason));
      }
    },

    buildEnd(error) {
      if (error) reportError("build", error, { environment: this.environment?.name });
    },
  };
}
