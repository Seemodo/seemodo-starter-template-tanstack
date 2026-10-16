// @seemodo.ai/vite-tanstack-config
//
// One-call Vite config for Seemodo TanStack Start apps. Plain ESM JavaScript on
// purpose: Vite loads config dependencies straight from node_modules, so this
// package needs no build step.
//
// Copyright (c) 2026 Seemodo. MIT License.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, version as viteVersion } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export const DEFAULT_PORT = 5173;
export const DEFAULT_NITRO_PRESET = "cloudflare-module";
export const DEFAULT_COMPATIBILITY_DATE = "2025-09-01";
export const ERROR_PREFIX = "[seemodo:error]";

const DEDUPE = ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-query"];

const WATCH_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.output/**",
  "**/dist/**",
  "**/.nitro/**",
  "**/.vinxi/**",
  "**/.tanstack/**",
  "**/.wrangler/**",
];

/**
 * True inside a Seemodo sandbox (Modal / Boat), where the dev server sits
 * behind an HTTPS proxy and the browser must reach HMR over wss on port 443.
 */
export function isSeemodoSandbox(env = process.env) {
  const flag = (env.SEEMODO_SANDBOX ?? "").toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return typeof env.SANDBOX_APP_DIR === "string" && env.SANDBOX_APP_DIR.length > 0;
}

function resolvePort(env = process.env) {
  const parsed = Number.parseInt(env.PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

const MAX_FIELD = 8000;

function clip(value) {
  if (typeof value !== "string") return value;
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
}

function stripAnsi(value) {
  return typeof value === "string" ? value.replace(/\u001b\[[0-9;]*m/g, "") : value;
}

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

/**
 * Writes one line to stderr: `[seemodo:error] {"source":...,"message":...}`.
 * The payload is single-line JSON so the sandbox control server can parse it.
 */
let reportCount = 0;

export function reportError(source, error, extra = {}) {
  reportCount += 1;
  const payload = { source, ...describe(error), ...extra, time: new Date().toISOString() };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      delete payload[key];
    } else {
      payload[key] = clip(payload[key]);
    }
  }
  try {
    process.stderr.write(`${ERROR_PREFIX} ${JSON.stringify(payload)}\n`);
  } catch {
    // stderr closed: nothing useful left to do
  }
}

function errorLoggerPlugin() {
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

// ---------------------------------------------------------------------------
// Editor bridge (dev only)
// ---------------------------------------------------------------------------

// Serve an empty script when the sandbox has not written public/seemodo.js, so
// the dev-only <script src="/seemodo.js"> in __root.tsx never falls through to
// the SSR router (which would answer with the app's 404 page as HTML).
function editorBridgeFallbackPlugin() {
  return {
    name: "seemodo:editor-bridge-fallback",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== "/seemodo.js") return next();
        const publicDir = server.config.publicDir;
        if (publicDir && existsSync(path.join(publicDir, "seemodo.js"))) return next();
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end("/* seemodo editor bridge not present */\n");
      });
    },
  };
}

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

async function loadNitro(options) {
  try {
    const mod = await import("nitro/vite");
    return mod.nitro;
  } catch (error) {
    if (options.nitro !== undefined) {
      throw new Error(
        `[seemodo] "nitro" is required for this build but could not be loaded. Install it with \`bun add -d nitro\`.`,
        { cause: error },
      );
    }
    console.warn('[seemodo] "nitro" is not installed; building without a deploy target.');
    return undefined;
  }
}

// Cloudflare worker names: lowercase letters, digits and dashes, at most 63
// characters. Nitro's own fallback (git remote or package name plus the path
// below the detected workspace) can exceed that, so pin it to the package name
// unless the app brings its own wrangler config.
function defaultWorkerName(root) {
  if (
    ["wrangler.json", "wrangler.jsonc", "wrangler.toml"].some((f) => existsSync(path.join(root, f)))
  ) {
    return undefined;
  }
  try {
    const { name } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof name !== "string") return undefined;
    const clean = name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "");
    return clean || undefined;
  } catch {
    return undefined;
  }
}

function nitroConfig(options, env, root) {
  const user = options.nitro && typeof options.nitro === "object" ? options.nitro : {};
  const preset =
    user.preset ?? env.SEEMODO_NITRO_PRESET ?? env.NITRO_PRESET ?? DEFAULT_NITRO_PRESET;
  const config = {
    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
    ...user,
    preset,
  };
  if (preset.startsWith("cloudflare") && !user.cloudflare?.wrangler?.name) {
    const name = defaultWorkerName(root);
    if (name) {
      config.cloudflare = {
        ...user.cloudflare,
        wrangler: { ...user.cloudflare?.wrangler, name },
      };
    }
  }
  return config;
}

// Vite 8 resolves tsconfig `paths` natively (and warns when vite-tsconfig-paths
// is present); older Vite versions need the plugin.
const VITE_MAJOR = Number.parseInt(viteVersion, 10);

async function tsconfigPathsSetup(mode) {
  if (mode === false) return { plugins: [], resolve: {} };
  if (mode === "native" || (mode !== "plugin" && VITE_MAJOR >= 8)) {
    return { plugins: [], resolve: { tsconfigPaths: true } };
  }
  const { default: tsconfigPaths } = await import("vite-tsconfig-paths");
  return { plugins: [tsconfigPaths()], resolve: {} };
}

/**
 * @param {import("./index.d.ts").SeemodoTanstackOptions} [options]
 */
export function defineConfig(options = {}) {
  return async (configEnv) => {
    const env = process.env;
    const isBuild = configEnv.command === "build";
    const isPreview = Boolean(configEnv.isPreview);
    const isDev = configEnv.command === "serve" && !isPreview;
    const sandbox = isSeemodoSandbox(env);
    const root = path.resolve(options.vite?.root ?? process.cwd());

    const paths = await tsconfigPathsSetup(options.tsconfigPaths ?? "auto");
    const plugins = [...paths.plugins];
    if (options.tailwind !== false) plugins.push(tailwindcss());
    plugins.push(tanstackStart(options.tanstackStart ?? {}));
    plugins.push(viteReact(options.react ?? {}));

    if ((isBuild || isPreview) && options.nitro !== false) {
      const nitro = await loadNitro(options);
      if (nitro) plugins.push(nitro(nitroConfig(options, env, root)));
    }

    if (options.errorLogger !== false) plugins.push(errorLoggerPlugin());
    if (isDev && options.editorBridge !== false) plugins.push(editorBridgeFallbackPlugin());
    if (options.plugins) plugins.push(...options.plugins);

    /** @type {import("vite").UserConfig} */
    const base = {
      plugins,
      resolve: {
        alias: [{ find: /^@\//, replacement: `${path.join(root, "src")}/` }],
        dedupe: DEDUPE,
        ...paths.resolve,
      },
      server: {
        host: "0.0.0.0",
        port: resolvePort(env),
        strictPort: true,
        allowedHosts: true,
        ...(sandbox && { hmr: { clientPort: 443, protocol: "wss" } }),
        watch: { ignored: WATCH_IGNORED },
      },
      preview: {
        host: "0.0.0.0",
        allowedHosts: true,
      },
    };

    return options.vite ? mergeConfig(base, options.vite) : base;
  };
}

export default defineConfig;
