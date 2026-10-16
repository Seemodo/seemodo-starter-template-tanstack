// Type declarations for @seemodo/vite-tanstack-config/hmr-gate.
// Copyright (c) 2026 Seemodo. MIT License.

import type { Plugin } from "vite";

export declare const HMR_GATE_PATH: "/__seemodo/hmr-gate";
export declare const HMR_FLUSH_PATH: "/__seemodo/hmr-flush";
export declare const DEV_SERVER_MODE_EVENT: "seemodo:dev-server-mode";
export declare const BOOT_PROGRESS_EVENT: "seemodo:boot-progress";
export declare const UPDATE_PROGRESS_EVENT: "seemodo:update-progress";
export declare const HMR_GATE_EVENT: "seemodo:hmr-gate";
export declare const FULL_RELOAD_ENV: "SEEMODO_HMR_FULL_RELOAD";
export declare const DEV_BRIDGE_TOKEN_ENV: "SEEMODO_DEV_BRIDGE_TOKEN";
export declare const DEFAULT_MAX_HOLD_MS: number;

export interface HmrGateOptions {
  /** One full page reload after each flush instead of granular HMR. Default: `SEEMODO_HMR_FULL_RELOAD`, else `false`. */
  fullReload?: boolean;
  /** Longest pause before the gate opens by itself. Default 120000, clamped to 1 s–10 min. */
  maxHoldMs?: number;
  /** Start paused (released by the first flush or after `maxHoldMs`). */
  startPaused?: boolean;
  /** Watcher events to hold. Default `["change", "add", "unlink"]`. */
  events?: ("change" | "add" | "unlink")[];
  /** Path substrings that are never held. */
  passthrough?: string[];
  /** Shared secret for the control endpoints. Default `SEEMODO_DEV_BRIDGE_TOKEN`. */
  token?: string;
}

export interface BuildErrorSummary {
  message: string;
  file: string | null;
  line: number | null;
}

/** `seemodo:dev-server-mode`, sent to each client when it connects. */
export interface DevServerModeData {
  mode: "classic" | "bundled";
  hmr: "granular" | "full-reload";
  gate: boolean;
  startedAt: string;
}

/** `seemodo:boot-progress`: modules transformed so far (throttled to 2/s). */
export interface BootProgressData {
  ssrModules: number;
  clientModules: number;
  /** Milliseconds since the last transform, measured on the server. */
  ssrIdleMs: number | null;
  clientIdleMs: number | null;
  buildError: BuildErrorSummary | null;
}

export type UpdateTrigger = "flush" | "timeout" | "watch";

/** `seemodo:update-progress`: one batch of updates after a flush or a file change. */
export interface UpdateProgressData {
  batch: number;
  trigger: UpdateTrigger;
  files: number;
  ssrModules: number;
  clientModules: number;
  idleMs: number | null;
  done: boolean;
  buildError: BuildErrorSummary | null;
}

/** Gate status (GET /__seemodo/hmr-gate and the `seemodo:hmr-gate` event). */
export interface HmrGateStatus {
  state: "open" | "paused";
  reason: string | null;
  pausedAt: string | null;
  autoResumeAt: string | null;
  pendingCount: number;
  pending: string[];
  errorRecovery: boolean;
  pauses: number;
  flushes: number;
}

export interface GateState {
  readonly paused: boolean;
  pause(options?: { reason?: string; timeoutMs?: number }): void;
  hold(event: string, file: string): boolean;
  noteErrorPage(): void;
  release(): { entries: [string, string[]][]; heldMs: number; errorRecovery: boolean };
  status(): HmrGateStatus;
  dispose(): void;
}

export declare function createGateState(options?: {
  maxHoldMs?: number;
  onExpire?: (trigger: "timeout") => void;
  hash?: (file: string) => string | undefined;
}): GateState;

export declare function resolveFullReload(
  option: boolean | undefined,
  env?: Record<string, string | undefined>,
): boolean;

export declare function hmrGatePlugin(options?: HmrGateOptions): Plugin & {
  api: {
    pause(options?: { reason?: string; timeoutMs?: number }): void;
    flush(trigger?: UpdateTrigger): {
      entries: [string, string[]][];
      heldMs: number;
      errorRecovery: boolean;
    };
    status(): HmrGateStatus & {
      enabled: boolean;
      mode: "granular" | "full-reload";
      maxHoldMs: number;
    };
  };
};
export default hmrGatePlugin;
