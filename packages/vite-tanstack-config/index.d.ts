// Type declarations for @seemodo.ai/vite-tanstack-config.
// Copyright (c) 2026 Seemodo. MIT License.

import type { ConfigEnv, PluginOption, UserConfig } from "vite";
import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { Options as ReactPluginOptions } from "@vitejs/plugin-react";
import type { NitroPluginConfig } from "nitro/vite";

/** Options forwarded to `tanstackStart()` from `@tanstack/react-start/plugin/vite`. */
export type TanstackStartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

/** Options forwarded to `nitro()` from `nitro/vite`. */
export type NitroOptions = NitroPluginConfig;

export interface SeemodoTanstackOptions {
  /**
   * Options for `tanstackStart()`, e.g. `{ server: { entry: "server" } }` to use
   * `src/server.ts` as the server entry.
   */
  tanstackStart?: TanstackStartOptions;

  /** Options for `@vitejs/plugin-react`. */
  react?: ReactPluginOptions;

  /**
   * Nitro, used for `vite build` and `vite preview` only (never in dev).
   *
   * - `undefined` (default): enabled when `nitro` is installed.
   * - object: enabled with these options (merged over the defaults); fails the
   *   build if `nitro` is not installed.
   * - `false`: disabled; TanStack Start writes its plain `dist/` output.
   *
   * Preset precedence: `nitro.preset` > `SEEMODO_NITRO_PRESET` > `NITRO_PRESET`
   * > `"cloudflare-module"` (Cloudflare Workers with static assets).
   * `compatibilityDate` defaults to `DEFAULT_COMPATIBILITY_DATE`.
   */
  nitro?: NitroOptions | false;

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

  /**
   * Dev only: answer `/seemodo.js` with an empty script when
   * `public/seemodo.js` does not exist. Default `true`.
   */
  editorBridge?: boolean;

  /** Extra Vite plugins, added after the built-in ones. */
  plugins?: PluginOption[];

  /** Plain Vite config, merged last with `mergeConfig` (wins over the defaults). */
  vite?: UserConfig;
}

/** Shape of the JSON payload after the `[seemodo:error] ` prefix. */
export interface SeemodoErrorReport {
  source: "vite" | "ssr" | "http" | "server-fn" | "process" | "build" | (string & {});
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
  /** ISO timestamp. */
  time: string;
}

/** Builds the Vite config. Use as `export default defineConfig({ ... })` in vite.config.ts. */
export declare function defineConfig(
  options?: SeemodoTanstackOptions,
): (env: ConfigEnv) => Promise<UserConfig>;
export default defineConfig;

/** `true` when `SEEMODO_SANDBOX` is 1/true/yes or `SANDBOX_APP_DIR` is set. */
export declare function isSeemodoSandbox(env?: Record<string, string | undefined>): boolean;

/** Writes one `[seemodo:error] {json}` line to stderr. */
export declare function reportError(
  source: SeemodoErrorReport["source"],
  error: unknown,
  extra?: Record<string, unknown>,
): void;

export declare const DEFAULT_PORT: 5173;
export declare const DEFAULT_NITRO_PRESET: "cloudflare-module";
export declare const DEFAULT_COMPATIBILITY_DATE: string;
export declare const ERROR_PREFIX: "[seemodo:error]";
