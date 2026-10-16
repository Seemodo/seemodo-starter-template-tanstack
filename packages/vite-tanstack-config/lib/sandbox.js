// Environment detection and small shared helpers.
// Copyright (c) 2026 Seemodo. MIT License.

export const PACKAGE_NAME = "@seemodo/vite-tanstack-config";

/** Prefix for log lines printed by this package. */
export const LOG_TAG = "[seemodo]";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Reads an on/off style environment value.
 * Returns `true`, `false`, or `undefined` when the value is unset or unknown.
 */
export function envSwitch(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

/**
 * True inside a Seemodo sandbox (Modal / Boat), where the dev server sits
 * behind an HTTPS proxy and the browser must reach HMR over wss on port 443.
 */
export function isSeemodoSandbox(env = process.env) {
  if (envSwitch(env.SEEMODO_SANDBOX) === true) return true;
  return typeof env.SANDBOX_APP_DIR === "string" && env.SANDBOX_APP_DIR.length > 0;
}

export function warn(message) {
  console.warn(`${LOG_TAG} ${message}`);
}

/** Pathname of a Node request URL, without query string or hash. */
export function pathnameOf(req) {
  const url = req.url ?? "";
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Clamps a number into [min, max]; non-numbers yield `fallback`. */
export function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Truncates a string to `max` characters, marking the cut. */
export function clipText(value, max) {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value;
}

/** Removes ANSI color sequences (Vite and esbuild color their messages). */
export function stripAnsi(value) {
  return typeof value === "string" ? value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "") : value;
}
