// Type declarations for @seemodo/vite-tanstack-config.
// Copyright (c) 2026 Seemodo. MIT License.

import type {
  ConfigEnv,
  Plugin,
  PluginOption,
  UserConfig,
  UserConfigFnObject,
  UserConfigFnPromise,
  UserConfigFn,
} from "vite";
import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { Options as ReactPluginOptions } from "@vitejs/plugin-react";
import type { NitroPluginConfig } from "nitro/vite";
import type { HmrGateOptions } from "./hmr-gate.js";
import type { DevServerBridgeOptions } from "./dev-server-bridge.js";

export type { HmrGateOptions } from "./hmr-gate.js";
export type { DevServerBridgeOptions, ErrorCollectorOptions } from "./dev-server-bridge.js";

/** Options forwarded to `tanstackStart()` from `@tanstack/react-start/plugin/vite`. */
export type TanstackStartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

/**
 * Options forwarded to `nitro()` from `nitro/vite`. The keys below are the ones
 * this package reads itself; every other Nitro option is passed through.
 */
export type NitroOptions = NitroPluginConfig & {
  preset?: string;
  output?: { dir?: string; publicDir?: string; serverDir?: string };
  cloudflare?: NitroPluginConfig["cloudflare"] & { nodeCompat?: boolean; deployConfig?: boolean };
};

export interface BuildExitWatchdogOptions {
  /** Default `true` (Seemodo sandbox builds only). */
  enabled?: boolean;
  /** Grace after the last build hook before the process is ended. Clamped to 5 s–10 min. Default 60000. */
  graceMs?: number;
}

export interface SeemodoTanstackOptions {
  /**
   * Options for `tanstackStart()`, e.g. `{ server: { entry: "server" } }` to use
   * `src/server.ts` as the server entry, or `{ prerender: { enabled: true } }`.
   * Inside a Seemodo sandbox build the prerender output shape is pinned
   * (`<route>/index.html`, failed routes fall back to SSR).
   */
  tanstackStart?: TanstackStartOptions;

  /** Options for `@vitejs/plugin-react`. */
  react?: ReactPluginOptions;

  /**
   * Nitro, used for `vite build` and `vite preview` only (never in dev).
   *
   * - `undefined` (default): on when `nitro` is installed (required inside a
   *   Seemodo sandbox). Without an explicit target Nitro falls back to
   *   `"cloudflare-module"`; `NITRO_PRESET` and Nitro's provider detection win.
   * - `true`: same, but the build fails when `nitro` is missing.
   * - object: on with these options; fails when `nitro` is missing.
   * - `false`: off; TanStack Start writes its plain `dist/` output.
   *
   * `SEEMODO_NITRO_PRESET` pins the preset over everything. Inside a Seemodo
   * sandbox build the preset is `SEEMODO_NITRO_PRESET` or `cloudflare-module`
   * and the output is always `.output/public` + `.output/server`.
   */
  nitro?: NitroOptions | boolean;

  /** Add `@tailwindcss/vite`. Default `true`. */
  tailwind?: boolean;

  /**
   * tsconfig `paths` resolution.
   * - `"auto"` (default): Vite's native `resolve.tsconfigPaths` on Vite 8+,
   *   the `vite-tsconfig-paths` plugin on older Vite.
   * - `"native"` / `"plugin"`: force one of the two.
   * - `false`: off (the `@/` alias to `src/` still applies).
   */
  tsconfigPaths?: "auto" | "native" | "plugin" | false;

  /**
   * Print Vite, SSR, server-function, 5xx and build errors to stderr as
   * `[seemodo:error] {json}` lines. Default `true`.
   */
  errorLogger?: boolean;

  /** Dev only: answer `/seemodo.js` with an empty script when `public/seemodo.js` does not exist. Default `true`. */
  editorBridge?: boolean;

  /** Define `import.meta.env.VITE_*` from .env files and the process environment. Default `true`. */
  envDefine?: boolean;

  /** HMR gate (dev). Default on inside a Seemodo sandbox; `true` or options enable it elsewhere. */
  hmrGate?: boolean | HmrGateOptions;

  /** Dev server bridge (error collector, restart announce, preview execute). Default on inside a Seemodo sandbox. */
  devServerBridge?: boolean | DevServerBridgeOptions;

  /** `[seemodo-build-report]` blocks for build errors. Default on inside a Seemodo sandbox. */
  buildDiagnostics?: boolean;

  /** Forced exit of a sandbox build that keeps running after its output is written. */
  buildExitWatchdog?: BuildExitWatchdogOptions | false;

  /** Drop `nodejs_compat` flags from the generated wrangler.json when the compatibility date implies them. Default `true`. */
  fixWranglerConfig?: boolean;

  /** Dev asset proxy driven by `SEEMODO_PREVIEW_HOST` + `SEEMODO_ASSETS_PATH`. `false` disables it. */
  assetsProxy?: boolean;

  /** Extra Vite plugins, added after the built-in ones. */
  plugins?: PluginOption[];

  /** Plain Vite config, merged last with `mergeConfig` (wins over the defaults). */
  vite?: UserConfig;
}

/** Shape of the JSON payload after the `[seemodo:error] ` prefix. */
export interface SeemodoErrorReport {
  source:
    | "vite"
    | "ssr"
    | "http"
    | "server-fn"
    | "process"
    | "console"
    | "build"
    | "browser"
    | (string & {});
  message: string;
  name?: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
  plugin?: string;
  frame?: string;
  method?: string;
  url?: string;
  status?: number;
  environment?: string;
  /** Browser reports: "runtime-error" | "unhandled-rejection" | "resource-error". */
  type?: string;
  /** ISO timestamp. */
  time: string;
  [key: string]: unknown;
}

type ConfigFactory = (env: ConfigEnv) => Promise<UserConfig>;

/** Builds the Vite config. Use as `export default defineConfig({ ... })` in vite.config.ts. */
export declare function defineConfig(options?: SeemodoTanstackOptions): ConfigFactory;
/** Wraps a plain Vite config; the Seemodo defaults still apply underneath. */
export declare function defineConfig(config: UserConfig): ConfigFactory;
export declare function defineConfig(config: Promise<UserConfig>): ConfigFactory;
export declare function defineConfig(config: UserConfigFnObject): ConfigFactory;
export declare function defineConfig(config: UserConfigFnPromise): ConfigFactory;
export declare function defineConfig(config: UserConfigFn): ConfigFactory;
export default defineConfig;

/** Normalizes any `defineConfig` input into the options object. */
export declare function normalizeInput(
  input: unknown,
  env: ConfigEnv,
): Promise<SeemodoTanstackOptions>;

/** Option keys recognized by `defineConfig`; other keys are treated as Vite config. */
export declare const OPTION_KEYS: readonly (keyof SeemodoTanstackOptions)[];

/** `import.meta.env.<KEY>` defines for every env variable with the given prefix(es). */
export declare function envDefines(
  mode: string,
  root: string,
  prefixes?: string | string[],
): Record<string, string>;

/** `true` when `SEEMODO_SANDBOX` is 1/true/yes/on or `SANDBOX_APP_DIR` is set. */
export declare function isSeemodoSandbox(env?: Record<string, string | undefined>): boolean;

/** Writes one `[seemodo:error] {json}` line to stderr and returns the payload. */
export declare function reportError(
  source: SeemodoErrorReport["source"],
  error: unknown,
  extra?: Record<string, unknown>,
): SeemodoErrorReport;

/** Subscribes to every `[seemodo:error]` report written in this process. Returns an unsubscribe function. */
export declare function onErrorReport(listener: (report: SeemodoErrorReport) => void): () => void;

/** Shrinks any thrown value into JSON-safe data whose serialization fits `maxChars`. */
export declare function compactDiagnostic(value: unknown, maxChars?: number): unknown;

/** Vite plugin printing `[seemodo-build-report]` for the first build error. */
export declare function buildReportPlugin(): Plugin;

export interface ResolvedNitro {
  enabled: boolean;
  required?: boolean;
  preset?: string | undefined;
  config?: Record<string, unknown>;
}

/** Decides whether and how Nitro runs (see the `nitro` option). */
export declare function resolveNitro(input: {
  option: SeemodoTanstackOptions["nitro"];
  sandbox: boolean;
  env: Record<string, string | undefined>;
  root: string;
}): ResolvedNitro;

/** Returns the wrangler config without flags implied by its compatibility date, or `undefined` when unchanged. */
export declare function withoutImpliedCompatFlags(
  wrangler: unknown,
): Record<string, unknown> | undefined;

/** Rewrites a wrangler.json file with `withoutImpliedCompatFlags`. Resolves to `true` when it changed. */
export declare function fixWranglerConfigFile(file: string): Promise<boolean>;

/** Vite plugin running `fixWranglerConfigFile` on Nitro's wrangler.json after the build. */
export declare function wranglerConfigFixPlugin(
  nitroConfig: Record<string, unknown>,
  seen?: { serverDir?: string | undefined },
): Plugin;

/** Mirrors TanStack Start's rule for whether the prerender pass runs. */
export declare function isPrerenderEnabled(startOptions: unknown): boolean;

/** Resolves the build exit watchdog from options and `SEEMODO_BUILD_EXIT_*` variables. */
export declare function resolveBuildExitWatchdog(
  option: BuildExitWatchdogOptions | false | undefined,
  env?: Record<string, string | undefined>,
): { enabled: boolean; graceMs: number };

export declare function buildExitWatchdogPlugin(
  options: { graceMs: number },
  deps?: { exit?: (code: number) => void },
): Plugin;

/** Validates `SEEMODO_PREVIEW_HOST` / `SEEMODO_ASSETS_PATH`. */
export declare function resolveAssetsProxy(env?: Record<string, string | undefined>): {
  config: { host: string; port: number; prefix: string } | undefined;
  error?: string;
};

export declare function assetsProxyPlugin(env?: Record<string, string | undefined>): Plugin;

export declare const DEFAULT_PORT: 5173;
export declare const DEFAULT_NITRO_PRESET: "cloudflare-module";
export declare const DEFAULT_COMPATIBILITY_DATE: string;
export declare const NODEJS_COMPAT_IMPLIED_FROM: string;
export declare const ERROR_PREFIX: "[seemodo:error]";
export declare const BUILD_REPORT_MARKER: "seemodo-build-report";
export declare const PRERENDER_REPORT_MARKER: "seemodo-prerender-report";
export declare const BUILD_EXIT_REPORT_MARKER: "seemodo-build-exit-report";
