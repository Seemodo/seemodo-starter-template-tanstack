// @seemodo/vite-tanstack-config
//
// One-call Vite config for Seemodo TanStack Start apps. Plain ESM JavaScript on
// purpose: Vite loads config dependencies straight from node_modules, so this
// package needs no build step.
//
// Copyright (c) 2026 Seemodo. MIT License.

import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnv, mergeConfig, version as viteVersion } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { assetsProxyPlugin } from "./lib/assets-proxy.js";
import { buildReportPlugin } from "./lib/diagnostics.js";
import {
  resolveNitro,
  serverDirCandidates,
  trackNitroOutput,
  wranglerConfigFixPlugin,
} from "./lib/nitro.js";
import {
  isPrerenderEnabled,
  isPrerenderPreview,
  prepareSandboxPrerender,
  prerenderServerPlugin,
} from "./lib/prerender.js";
import { errorLoggerPlugin } from "./lib/report.js";
import { isSeemodoSandbox, warn } from "./lib/sandbox.js";
import { buildExitWatchdogPlugin, resolveBuildExitWatchdog } from "./lib/watchdog.js";

export { isSeemodoSandbox } from "./lib/sandbox.js";
export { ERROR_PREFIX, onErrorReport, reportError } from "./lib/report.js";
export {
  BUILD_EXIT_REPORT_MARKER,
  BUILD_REPORT_MARKER,
  PRERENDER_REPORT_MARKER,
  buildReportPlugin,
  compactDiagnostic,
} from "./lib/diagnostics.js";
export {
  DEFAULT_COMPATIBILITY_DATE,
  DEFAULT_NITRO_PRESET,
  NODEJS_COMPAT_IMPLIED_FROM,
  fixWranglerConfigFile,
  resolveNitro,
  withoutImpliedCompatFlags,
  wranglerConfigFixPlugin,
} from "./lib/nitro.js";
export { isPrerenderEnabled } from "./lib/prerender.js";
export { buildExitWatchdogPlugin, resolveBuildExitWatchdog } from "./lib/watchdog.js";
export { assetsProxyPlugin, resolveAssetsProxy } from "./lib/assets-proxy.js";

export const DEFAULT_PORT = 5173;

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
  "**/.seemodo/**",
];

// Directories written by tools in the sandbox, never by the app.
const SANDBOX_WATCH_IGNORED = ["**/.claude/**", "**/.agents/**", "**/.workspace/**"];

/** Every option key `defineConfig` understands; anything else is treated as Vite config. */
export const OPTION_KEYS = Object.freeze([
  "tanstackStart",
  "react",
  "nitro",
  "tailwind",
  "tsconfigPaths",
  "errorLogger",
  "editorBridge",
  "envDefine",
  "hmrGate",
  "devServerBridge",
  "buildDiagnostics",
  "buildExitWatchdog",
  "fixWranglerConfig",
  "assetsProxy",
  "plugins",
  "vite",
]);

function resolvePort(env = process.env) {
  const parsed = Number.parseInt(env.PORT ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// Editor bridge fallback (dev only)
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
// Option normalization
// ---------------------------------------------------------------------------

/**
 * Turns whatever was passed to `defineConfig` into the options object.
 * Accepts the options object, a plain Vite config object, a Vite config
 * function, or a promise of a Vite config.
 */
export async function normalizeInput(input, configEnv) {
  if (input === undefined || input === null) return {};
  if (typeof input === "function") return { vite: (await input(configEnv)) ?? {} };
  if (typeof input.then === "function") return { vite: (await input) ?? {} };
  if (typeof input !== "object")
    throw new TypeError("defineConfig expects an object or a function");

  const options = {};
  const viteExtras = {};
  for (const [key, value] of Object.entries(input)) {
    if (OPTION_KEYS.includes(key)) options[key] = value;
    else viteExtras[key] = value;
  }
  if (Object.keys(viteExtras).length > 0) {
    options.vite = options.vite ? mergeConfig(viteExtras, options.vite) : viteExtras;
  }
  return options;
}

/** `envDefine`: defines `import.meta.env.VITE_*` from .env files and the build environment. */
export function envDefines(mode, root, prefixes = "VITE_") {
  const loaded = loadEnv(mode, root, prefixes);
  const define = {};
  for (const [key, value] of Object.entries(loaded)) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return define;
}

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

async function loadNitro(required) {
  try {
    const mod = await import("nitro/vite");
    return mod.nitro;
  } catch (error) {
    if (required) {
      throw new Error(
        '[seemodo] "nitro" is required for this build but could not be loaded. Install it with `bun add -d nitro`.',
        { cause: error },
      );
    }
    warn('"nitro" is not installed; building without a deploy target.');
    return undefined;
  }
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

function optionObject(value) {
  return value && typeof value === "object" ? value : {};
}

/**
 * Builds the Vite config. Use as `export default defineConfig({ ... })` in vite.config.ts.
 * @param {import("./index.d.ts").SeemodoTanstackOptions | import("vite").UserConfigExport} [input]
 */
export function defineConfig(input = {}) {
  return async (configEnv) => {
    const options = await normalizeInput(input, configEnv);
    const env = process.env;
    const isBuild = configEnv.command === "build";
    const isPreview = Boolean(configEnv.isPreview);
    const isDev = configEnv.command === "serve" && !isPreview;
    const prerenderPass = isPrerenderPreview(configEnv, env);
    const sandbox = isSeemodoSandbox(env);
    const root = path.resolve(options.vite?.root ?? process.cwd());

    const paths = await tsconfigPathsSetup(options.tsconfigPaths ?? "auto");
    const plugins = [...paths.plugins];
    if (options.tailwind !== false) plugins.push(tailwindcss());

    // TanStack Start (+ prerender handling)
    let startOptions = options.tanstackStart ?? {};
    let prerenderReporter;
    if (isBuild && sandbox && isPrerenderEnabled(startOptions)) {
      const prepared = prepareSandboxPrerender(startOptions);
      startOptions = prepared.options;
      prerenderReporter = prepared.reporter;
    }
    plugins.push(tanstackStart(startOptions));
    // After TanStack Start's own post-build hook, which runs the prerender pass.
    if (prerenderReporter) plugins.push(prerenderReporter);
    plugins.push(viteReact(options.react ?? {}));

    // Nitro: builds and `vite preview`, never in dev. During TanStack Start's
    // prerender pass the adapter in lib/prerender.js serves pages instead.
    const nitroPlan = resolveNitro({ option: options.nitro, sandbox, env, root });
    if (nitroPlan.enabled && (isBuild || isPreview)) {
      if (prerenderPass) {
        plugins.push(prerenderServerPlugin(() => serverDirCandidates(nitroPlan.config)));
      } else {
        const nitro = await loadNitro(nitroPlan.required);
        if (nitro) {
          const seen = trackNitroOutput(nitroPlan.config);
          plugins.push(nitro(nitroPlan.config));
          if (isBuild && options.fixWranglerConfig !== false) {
            plugins.push(wranglerConfigFixPlugin(nitroPlan.config, seen));
          }
        }
      }
    }

    if (options.errorLogger !== false) plugins.push(errorLoggerPlugin());

    if (isBuild && (options.buildDiagnostics ?? sandbox)) plugins.push(buildReportPlugin());

    let watchdog;
    if (isBuild && sandbox && options.buildExitWatchdog !== false) {
      const resolved = resolveBuildExitWatchdog(options.buildExitWatchdog, env);
      if (resolved.enabled) watchdog = buildExitWatchdogPlugin(resolved);
    }

    if (isDev) {
      if (options.editorBridge !== false) plugins.push(editorBridgeFallbackPlugin());
      const gate = options.hmrGate;
      if (sandbox ? gate !== false : Boolean(gate)) {
        const { hmrGatePlugin } = await import("./hmr-gate.js");
        plugins.push(hmrGatePlugin(optionObject(gate)));
      }
      const bridge = options.devServerBridge;
      if (sandbox ? bridge !== false : Boolean(bridge)) {
        const { devServerBridgePlugin } = await import("./dev-server-bridge.js");
        plugins.push(devServerBridgePlugin(optionObject(bridge)));
      }
      if (options.assetsProxy !== false) plugins.push(assetsProxyPlugin(env));
    }

    if (options.plugins) plugins.push(...options.plugins);

    /** @type {import("vite").UserConfig} */
    const base = {
      plugins,
      define:
        options.envDefine === false
          ? {}
          : envDefines(configEnv.mode, root, options.vite?.envPrefix ?? "VITE_"),
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
        watch: { ignored: sandbox ? [...WATCH_IGNORED, ...SANDBOX_WATCH_IGNORED] : WATCH_IGNORED },
      },
      preview: {
        host: "0.0.0.0",
        allowedHosts: true,
      },
    };

    let config = options.vite ? mergeConfig(base, options.vite) : base;
    // The watchdog must stay the very last plugin so its timer starts after every other build hook.
    if (watchdog) config = { ...config, plugins: [...(config.plugins ?? []), watchdog] };
    return config;
  };
}

export default defineConfig;
