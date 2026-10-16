// Machine-readable build reports for the Seemodo platform.
//
// Each report is one JSON document between an opening and a closing marker on
// stderr, for example:
//
//   [seemodo-build-report]
//   {"version":1,"kind":"build-error",...}
//   [/seemodo-build-report]
//
// Copyright (c) 2026 Seemodo. MIT License.

import { stripAnsi } from "./sandbox.js";

export const BUILD_REPORT_MARKER = "seemodo-build-report";
export const PRERENDER_REPORT_MARKER = "seemodo-prerender-report";
export const BUILD_EXIT_REPORT_MARKER = "seemodo-build-exit-report";

/** Upper bound for one report's JSON text. */
export const MAX_REPORT_CHARS = 6000;

// Successively tighter limits; the first one whose output fits is used.
const BUDGETS = [
  { text: 2000, depth: 5, items: 20 },
  { text: 500, depth: 4, items: 8 },
  { text: 160, depth: 3, items: 3 },
  { text: 80, depth: 2, items: 1 },
];

// Fields worth keeping from Vite / Rollup / Rolldown / esbuild errors, in output order.
const ERROR_KEYS = [
  "name",
  "message",
  "code",
  "plugin",
  "pluginCode",
  "hook",
  "id",
  "loc",
  "frame",
  "stack",
  "errors",
  "cause",
];

function safeGet(target, key) {
  try {
    return target[key];
  } catch (error) {
    return `[unreadable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function cut(text, max) {
  const clean = stripAnsi(text);
  return clean.length > max ? `${clean.slice(0, max)}…[+${clean.length - max} chars]` : clean;
}

function label(value) {
  switch (typeof value) {
    case "function":
      return `[function ${value.name || "anonymous"}]`;
    case "symbol":
      return value.toString();
    case "bigint":
      return `${value}n`;
    default:
      return String(value);
  }
}

function project(value, budget, depth, ancestors) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return cut(value, budget.text);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return label(value);
  if (ancestors.includes(value)) return "[circular]";
  if (depth >= budget.depth) return "[nested]";
  const path = [...ancestors, value];

  if (Array.isArray(value)) {
    const list = value.slice(0, budget.items).map((item) => project(item, budget, depth + 1, path));
    if (value.length > budget.items) list.push(`[+${value.length - budget.items} more]`);
    return list;
  }

  const out = {};
  const looksLikeError =
    value instanceof Error || ERROR_KEYS.some((key) => key !== "name" && key in value);
  const keys = looksLikeError ? ERROR_KEYS.filter((key) => key in value) : Object.keys(value);
  let kept = 0;
  for (const key of keys) {
    if (kept >= budget.items * 2) {
      out["…"] = `${keys.length - kept} more keys`;
      break;
    }
    const nested = safeGet(value, key);
    if (nested === undefined || nested === null || nested === "") continue;
    out[key] = project(nested, budget, depth + 1, path);
    kept += 1;
  }
  if (kept === 0 && !looksLikeError) {
    const name = value.constructor?.name;
    return name && name !== "Object" ? `[${name}]` : "{}";
  }
  return out;
}

/**
 * Turns any thrown value into JSON-safe data whose serialization fits
 * `maxChars`. Tries progressively smaller limits and finally falls back to a
 * one-line summary, so the result always fits.
 */
export function compactDiagnostic(value, maxChars = MAX_REPORT_CHARS) {
  for (const budget of BUDGETS) {
    const data = project(value, budget, 0, []);
    const json = JSON.stringify(data);
    if (json !== undefined && json.length <= maxChars) return data;
  }
  const message =
    value && typeof value === "object" && typeof safeGet(value, "message") === "string"
      ? safeGet(value, "message")
      : label(value);
  return { message: cut(message, Math.max(40, maxChars - 80)), truncated: true };
}

/** Formats a marker-wrapped report. `payload` must already be compact. */
export function formatReport(marker, payload) {
  return `\n[${marker}]\n${JSON.stringify(payload)}\n[/${marker}]\n`;
}

export function writeReport(marker, payload) {
  try {
    process.stderr.write(formatReport(marker, payload));
  } catch {
    // stderr closed
  }
}

/** Build error report payload (also used by tests). */
export function buildErrorReportPayload(error, environment) {
  const base = { version: 1, kind: "build-error", environment: environment ?? null };
  const room = MAX_REPORT_CHARS - JSON.stringify({ ...base, error: null }).length;
  return { ...base, error: compactDiagnostic(error, room) };
}

const MAX_ROUTES = 50;
const MAX_ROUTE_CHARS = 200;

/** Prerender summary payload: counts plus a bounded list of failed routes. */
export function prerenderReportPayload({ attempted, rendered, failed }) {
  const list = [...failed];
  return {
    version: 1,
    kind: "prerender",
    attempted,
    rendered,
    failed: list.slice(0, MAX_ROUTES).map((route) => cut(String(route), MAX_ROUTE_CHARS)),
    failedTotal: list.length,
  };
}

/**
 * Vite plugin: prints one `[seemodo-build-report]` for the first build error
 * (per build process), so the platform can show a precise cause even when the
 * human-readable output is long or interleaved.
 */
export function buildReportPlugin() {
  let sent = false;
  const send = (error, environment) => {
    if (!error || sent) return;
    sent = true;
    writeReport(BUILD_REPORT_MARKER, buildErrorReportPayload(error, environment));
  };
  return {
    name: "seemodo:build-report",
    apply: "build",
    buildEnd(error) {
      send(error, this.environment?.name);
    },
    renderError(error) {
      send(error, this.environment?.name);
    },
  };
}
