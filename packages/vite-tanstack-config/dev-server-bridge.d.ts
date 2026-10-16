// Type declarations for @seemodo/vite-tanstack-config/dev-server-bridge.
// Copyright (c) 2026 Seemodo. MIT License.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export declare const ERROR_COLLECTOR_PATH: "/__seemodo/error-collector";
export declare const RESTART_ANNOUNCE_PATH: "/__seemodo/restart-announce";
export declare const PREVIEW_EXECUTE_PATH: "/__seemodo/preview-execute";
export declare const VIEWERS_PATH: "/__seemodo/viewers";
export declare const RESTART_EVENT: "seemodo:dev-server-restarting";
export declare const SERVER_ERROR_EVENT: "seemodo:server-error";
export declare const PREVIEW_EXECUTE_EVENT: "seemodo:preview-execute";
export declare const PREVIEW_EXECUTE_RESULT_EVENT: "seemodo:preview-execute-result";
export declare const VIEWER_HELLO_EVENT: "seemodo:viewer-hello";
export declare const DEFAULT_ERROR_LOG: ".seemodo/dev-errors.jsonl";
export declare const DEFAULT_ERROR_BODY_LIMIT: number;

export interface ErrorCollectorOptions {
  /** Endpoint path. Default `/__seemodo/error-collector`. */
  endpoint?: string;
  /** JSON-lines log, relative to the project root. Default `.seemodo/dev-errors.jsonl`; `false` disables the file. */
  outputFile?: string | false;
  /** Largest accepted request body. Default 16 KiB. */
  maxBodyBytes?: number;
  /** Empty the log when the dev server starts. Default `true`. */
  resetOnStart?: boolean;
  /** Reports accepted per minute before answering 429. Default 120. */
  maxReportsPerMinute?: number;
}

export interface DevServerBridgeOptions {
  errorCollector?: ErrorCollectorOptions | false;
  /** Default `true`. */
  restartAnnounce?: boolean;
  /** Default `true` inside a Seemodo sandbox, `false` elsewhere. */
  previewExecute?: boolean;
  /** Forward server-side error reports to preview tabs (`seemodo:server-error`). Default `true`. */
  forwardServerErrors?: boolean;
  /** Shared secret for control endpoints. Default `SEEMODO_DEV_BRIDGE_TOKEN`. */
  token?: string;
}

export interface BrowserErrorReport {
  source: "browser";
  type: string;
  message: string;
  name?: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
  tag?: string;
  resource?: string;
  url?: string;
  userAgent?: string;
  viewerId?: string;
  time: string;
  receivedAt: string;
}

export interface ErrorCollector {
  readonly endpoint: string;
  readonly file: string | undefined;
  start(root: string): void;
  record(input: Record<string, unknown>): Promise<BrowserErrorReport>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export declare function normalizeBrowserReport(input: Record<string, unknown>): BrowserErrorReport;
export declare function createErrorCollector(options?: ErrorCollectorOptions): ErrorCollector;

export interface PreviewExecuteResult {
  viewerId: string | null;
  url: string | null;
  ok: boolean;
  durationMs: number | null;
  result?:
    | { kind: "json"; value: unknown }
    | { kind: "undefined" }
    | { kind: "truncated"; text?: string; length: number }
    | { kind: "unserializable"; text: string };
  error?: { name?: string; message: string; stack?: string } | null;
}

export interface PreviewExecuteResponse {
  id: string;
  viewers: number;
  responded: number;
  timedOut: number;
  results: PreviewExecuteResult[];
}

export declare function parseExecuteRequest(
  value: unknown,
): { code: string; timeoutMs: number; error?: undefined } | { error: string };

export declare function devServerBridgePlugin(options?: DevServerBridgeOptions): Plugin;
export default devServerBridgePlugin;
