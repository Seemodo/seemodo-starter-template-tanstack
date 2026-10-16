// Build exit watchdog: a sandbox build must end once its output is written.
//
// Server code evaluated during the build (prerendering, route loaders run at
// build time, module-scope timers, connection pools, TanStack Query's gcTime
// timers armed during SSR) can keep the Node event loop alive after Vite is
// done. The platform would then wait for its build timeout. The watchdog arms an
// unref'd timer after the last build hook; if the process is still alive when
// it fires, it prints the open handle types and exits.
//
// Copyright (c) 2026 Seemodo. MIT License.

import { BUILD_EXIT_REPORT_MARKER, writeReport } from "./diagnostics.js";
import { envSwitch, warn } from "./sandbox.js";

export const DEFAULT_EXIT_GRACE_MS = 60_000;
export const MIN_EXIT_GRACE_MS = 5_000;
export const MAX_EXIT_GRACE_MS = 600_000;
export const EXIT_GRACE_ENV = "SEEMODO_BUILD_EXIT_GRACE_MS";
export const EXIT_WATCHDOG_ENV = "SEEMODO_BUILD_EXIT_WATCHDOG";

export function clampGrace(ms) {
  return Math.min(MAX_EXIT_GRACE_MS, Math.max(MIN_EXIT_GRACE_MS, Math.round(ms)));
}

/**
 * Resolves `{ enabled, graceMs }` from the option and the environment.
 * Environment wins: `SEEMODO_BUILD_EXIT_WATCHDOG=off` disables, and
 * `SEEMODO_BUILD_EXIT_GRACE_MS` replaces the grace. Values are clamped to 5 s–10 min.
 */
export function resolveBuildExitWatchdog(option, env = process.env) {
  const config = option && typeof option === "object" ? option : {};
  let enabled = option !== false && config.enabled !== false;
  if (envSwitch(env[EXIT_WATCHDOG_ENV]) === false) enabled = false;
  else if (envSwitch(env[EXIT_WATCHDOG_ENV]) === true) enabled = true;

  let graceMs = DEFAULT_EXIT_GRACE_MS;
  if (config.graceMs !== undefined) {
    if (
      typeof config.graceMs === "number" &&
      Number.isFinite(config.graceMs) &&
      config.graceMs > 0
    ) {
      graceMs = clampGrace(config.graceMs);
    } else {
      warn(`buildExitWatchdog.graceMs must be a positive number of ms; using ${graceMs}.`);
    }
  }
  const fromEnv = env[EXIT_GRACE_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (/^\d+$/.test(fromEnv.trim()) && parsed > 0) graceMs = clampGrace(parsed);
    else warn(`${EXIT_GRACE_ENV}="${fromEnv}" is not a positive integer; ignoring it.`);
  }
  return { enabled, graceMs };
}

/** Counts the event-loop resources keeping the process alive, by type. */
export function openHandleSummary(limit = 20) {
  let resources = [];
  try {
    resources = process.getActiveResourcesInfo();
  } catch {
    // older Node: no data
  }
  const counts = {};
  for (const type of resources) {
    // stdio pipes are always there and say nothing about the hang
    if (type === "PipeWrap" || type === "TTYWrap") continue;
    const key = String(type).slice(0, 64);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit),
  );
}

export function buildExitWatchdogPlugin({ graceMs }, { exit = process.exit } = {}) {
  return {
    name: "seemodo:build-exit-watchdog",
    apply: "build",
    enforce: "post",
    buildApp: {
      order: "post",
      handler() {
        const timer = setTimeout(() => {
          const exitCode = Number(process.exitCode ?? 0) || 0;
          const handles = openHandleSummary();
          writeReport(BUILD_EXIT_REPORT_MARKER, {
            version: 1,
            kind: "build-exit",
            graceMs,
            exitCode,
            openHandles: handles,
          });
          const list = Object.entries(handles).map(([type, n]) => `${type}×${n}`);
          warn(
            `the build finished but the process was still running ${graceMs} ms later ` +
              `(open handles: ${list.join(", ") || "none reported"}); exiting with code ${exitCode}. ` +
              "Look for timers, intervals or open connections created at module scope in server code.",
          );
          exit(exitCode);
        }, graceMs);
        timer.unref?.();
      },
    },
  };
}
