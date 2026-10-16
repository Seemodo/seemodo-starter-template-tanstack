// HMR gate: hold file-change events while many files are being written, then
// release them together.
//
// When the Seemodo agent writes a change set (often dozens of files, in several
// batches), Vite would otherwise push an update for every single file. The
// preview then runs code where file A is new and file B is still old, shows
// error overlays and reloads repeatedly. The gate sits between the file
// watcher and Vite:
//
//   open    watcher events pass straight through (normal Vite behavior)
//   paused  change/add/unlink events are queued per file; nothing reaches Vite
//   flush   the queue is replayed in order and the gate opens again
//
// A paused gate always opens by itself after `maxHoldMs` (default 2 min) or the
// timeout given with the pause request, so a lost "resume" never freezes the
// preview.
//
// Control endpoints (dev server, loopback or token only, see README):
//   GET  /__seemodo/hmr-gate                       status
//   POST /__seemodo/hmr-gate  {"action":"pause"|"resume"|"status", "reason"?, "timeoutMs"?}
//   POST /__seemodo/hmr-flush                      flush now (same as resume)
//
// Copyright (c) 2026 Seemodo. MIT License.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isTrustedControlRequest, isPlainObject, readJson, sendJson } from "./lib/http.js";
import { clampNumber, envSwitch, LOG_TAG, pathnameOf } from "./lib/sandbox.js";

export const HMR_GATE_PATH = "/__seemodo/hmr-gate";
export const HMR_FLUSH_PATH = "/__seemodo/hmr-flush";

export const DEV_SERVER_MODE_EVENT = "seemodo:dev-server-mode";
export const BOOT_PROGRESS_EVENT = "seemodo:boot-progress";
export const UPDATE_PROGRESS_EVENT = "seemodo:update-progress";
export const HMR_GATE_EVENT = "seemodo:hmr-gate";

/** Set to 1/true to answer every flush with one full page reload instead of granular HMR. */
export const FULL_RELOAD_ENV = "SEEMODO_HMR_FULL_RELOAD";
export const DEV_BRIDGE_TOKEN_ENV = "SEEMODO_DEV_BRIDGE_TOKEN";

export const DEFAULT_MAX_HOLD_MS = 120_000;
const MIN_HOLD_MS = 1_000;
const MAX_HOLD_MS = 600_000;
const PROGRESS_INTERVAL_MS = 500;
const SETTLE_AFTER_TRANSFORM_MS = 800;
const SETTLE_WITHOUT_TRANSFORM_MS = 3_000;
const RELOAD_QUIET_MS = 250;
const RELOAD_MAX_WAIT_MS = 3_000;
const GATED_EVENTS = ["change", "add", "unlink"];
// Paths that are never held: Vite's own cache and our own log file.
const ALWAYS_PASS = ["/node_modules/.vite/", "/.seemodo/"];

function contentHash(file) {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("base64");
  } catch {
    return undefined;
  }
}

/**
 * The gate's state machine, independent of Vite (exported for tests and for
 * custom integrations).
 *
 * @param {object} [options]
 * @param {number} [options.maxHoldMs]  hard upper bound for one pause
 * @param {(trigger: "timeout") => void} [options.onExpire]  called when a pause times out
 * @param {(file: string) => string | undefined} [options.hash]  content hash for dedupe
 */
export function createGateState({
  maxHoldMs = DEFAULT_MAX_HOLD_MS,
  onExpire,
  hash = contentHash,
} = {}) {
  /** @type {Map<string, string[]>} file -> events in arrival order (deduplicated) */
  const queue = new Map();
  const released = new Map(); // file -> hash at its last release
  let paused = false;
  let pausedAt = 0;
  let reason;
  let expiresAt = 0;
  let timer;
  let pauses = 0;
  let flushes = 0;
  let errorServed = false;

  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const arm = (ms) => {
    disarm();
    expiresAt = Date.now() + ms;
    timer = setTimeout(() => {
      timer = undefined;
      if (paused) onExpire?.("timeout");
    }, ms);
    timer.unref?.();
  };

  return {
    get paused() {
      return paused;
    },
    pause({ reason: why, timeoutMs } = {}) {
      const ms = clampNumber(timeoutMs, MIN_HOLD_MS, maxHoldMs, maxHoldMs);
      if (!paused) {
        paused = true;
        pausedAt = Date.now();
        pauses += 1;
      }
      reason = typeof why === "string" && why ? why.slice(0, 200) : reason;
      arm(ms);
    },
    /** Returns true when the event was taken into the queue (or dropped as a no-op). */
    hold(event, file) {
      if (!paused) return false;
      if ((event === "change" || event === "add") && !queue.has(file)) {
        const current = hash(file);
        if (current !== undefined && current === released.get(file)) return true; // rewritten unchanged
      }
      const events = queue.get(file) ?? [];
      if (events.at(-1) !== event) events.push(event);
      queue.set(file, events);
      return true;
    },
    noteErrorPage() {
      if (paused) errorServed = true;
    },
    /** Opens the gate and hands back everything that was held. */
    release() {
      disarm();
      const entries = [...queue.entries()];
      const recovered = errorServed;
      queue.clear();
      for (const [file] of entries) {
        const current = hash(file);
        if (current === undefined) released.delete(file);
        else released.set(file, current);
      }
      const heldMs = paused ? Date.now() - pausedAt : 0;
      paused = false;
      reason = undefined;
      expiresAt = 0;
      errorServed = false;
      if (entries.length > 0 || heldMs > 0) flushes += 1;
      return { entries, heldMs, errorRecovery: recovered };
    },
    status() {
      return {
        state: paused ? "paused" : "open",
        reason: reason ?? null,
        pausedAt: paused ? new Date(pausedAt).toISOString() : null,
        autoResumeAt: paused ? new Date(expiresAt).toISOString() : null,
        pendingCount: queue.size,
        pending: [...queue.keys()].slice(0, 200),
        errorRecovery: errorServed,
        pauses,
        flushes,
      };
    },
    dispose() {
      disarm();
      queue.clear();
      released.clear();
      paused = false;
    },
  };
}

/** Resolves the `fullReload` flag: explicit option, else `SEEMODO_HMR_FULL_RELOAD`, else false. */
export function resolveFullReload(option, env = process.env) {
  if (typeof option === "boolean") return option;
  return envSwitch(env[FULL_RELOAD_ENV]) === true;
}

function firstBuildError(error) {
  if (!error || typeof error !== "object") return null;
  const first = Array.isArray(error.errors) && error.errors.length > 0 ? error.errors[0] : error;
  const file = first?.loc?.file ?? first?.id ?? null;
  return {
    message: String(first?.message ?? "Build failed").slice(0, 2000),
    file: typeof file === "string" ? file : null,
    line: typeof first?.loc?.line === "number" ? first.loc.line : null,
  };
}

/**
 * Vite plugin. Options:
 * - `fullReload`: after a flush send one full page reload instead of granular
 *   updates (default: `SEEMODO_HMR_FULL_RELOAD`, else off)
 * - `maxHoldMs`: longest possible pause (default 120000, max 600000)
 * - `startPaused`: begin paused (e.g. while the initial project is synced)
 * - `events`: watcher events to hold (default change, add, unlink)
 * - `passthrough`: path substrings that are never held
 * - `token`: shared secret for the endpoints (default `SEEMODO_DEV_BRIDGE_TOKEN`)
 */
export function hmrGatePlugin(options = {}) {
  const fullReload = resolveFullReload(options.fullReload);
  const maxHoldMs = clampNumber(options.maxHoldMs, MIN_HOLD_MS, MAX_HOLD_MS, DEFAULT_MAX_HOLD_MS);
  const held = new Set(options.events ?? GATED_EVENTS);
  const passthrough = [...ALWAYS_PASS, ...(options.passthrough ?? [])];
  const token = options.token ?? process.env[DEV_BRIDGE_TOKEN_ENV] ?? "";

  let server;
  let bundled = false;
  let originalEmit;
  let broadcast = () => {};
  const restoreSends = [];
  const startedAt = Date.now();
  const gate = createGateState({ maxHoldMs, onExpire: (trigger) => flush(trigger) });

  // --- progress reporting -------------------------------------------------
  const modules = new Map(); // environment -> { ids:Set, lastAt }
  const buildErrors = new Map(); // environment -> error summary
  let bootKey = "";
  let bootSentAt = 0;
  let bootTimer;
  let batch; // { id, trigger, files, ids:Map<env,Set>, lastAt, openedAt }
  let batchSeq = 0;
  let batchKey = "";
  let batchSentAt = 0;
  let batchTimer;
  let settleTimer;

  const buildError = () => buildErrors.values().next().value ?? null;
  const idle = (at) => (at ? Date.now() - at : null);

  function bootData() {
    return {
      ssrModules: modules.get("ssr")?.ids.size ?? 0,
      clientModules: modules.get("client")?.ids.size ?? 0,
      ssrIdleMs: idle(modules.get("ssr")?.lastAt),
      clientIdleMs: idle(modules.get("client")?.lastAt),
      buildError: buildError(),
    };
  }

  function sendBoot() {
    const data = bootData();
    const key = `${data.ssrModules}|${data.clientModules}|${data.buildError?.message ?? ""}`;
    if (key === bootKey) return;
    bootKey = key;
    bootSentAt = Date.now();
    broadcast(BOOT_PROGRESS_EVENT, data);
  }

  function scheduleBoot() {
    if (bootTimer) return;
    const wait = bootSentAt + PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) return sendBoot();
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      sendBoot();
    }, wait);
    bootTimer.unref?.();
  }

  function batchData(done) {
    return {
      batch: batch.id,
      trigger: batch.trigger,
      files: batch.files,
      ssrModules: batch.ids.get("ssr")?.size ?? 0,
      clientModules: batch.ids.get("client")?.size ?? 0,
      idleMs: idle(batch.lastAt),
      done,
      buildError: buildError(),
    };
  }

  function sendBatch(done = false) {
    if (!batch) return;
    const data = batchData(done);
    const key = `${data.batch}|${data.ssrModules}|${data.clientModules}|${done}|${data.buildError?.message ?? ""}`;
    if (key === batchKey) return;
    batchKey = key;
    batchSentAt = Date.now();
    broadcast(UPDATE_PROGRESS_EVENT, data);
  }

  function scheduleBatch() {
    if (batchTimer) return;
    const wait = batchSentAt + PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) return sendBatch();
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      sendBatch();
    }, wait);
    batchTimer.unref?.();
  }

  function settleBatch(ms) {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = undefined;
      sendBatch(true);
      batch = undefined;
    }, ms);
    settleTimer.unref?.();
  }

  function openBatch(trigger, files) {
    if (batch) {
      batch.trigger = trigger;
      batch.files += files;
    } else {
      batchSeq += 1;
      batch = { id: batchSeq, trigger, files, ids: new Map(), lastAt: 0, openedAt: Date.now() };
    }
    scheduleBatch();
    settleBatch(SETTLE_WITHOUT_TRANSFORM_MS);
  }

  // --- reload coalescing (fullReload mode) --------------------------------
  let coalescing = false;
  let reloadTimer;
  let reloadDeadline = 0;
  let sendRaw = () => {};

  function finishReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
    coalescing = false;
    sendRaw({ type: "full-reload", path: "*" });
  }

  function extendReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    const wait = Math.min(RELOAD_QUIET_MS, Math.max(0, reloadDeadline - Date.now()));
    reloadTimer = setTimeout(finishReload, wait);
    reloadTimer.unref?.();
  }

  function startReload() {
    coalescing = true;
    reloadDeadline = Date.now() + RELOAD_MAX_WAIT_MS;
    extendReload();
  }

  // --- flushing -------------------------------------------------------------
  function flush(trigger = "flush") {
    const { entries, heldMs, errorRecovery } = gate.release();
    broadcast(HMR_GATE_EVENT, gate.status());
    if (!server || !originalEmit) return { entries, heldMs, errorRecovery };
    if (entries.length > 0) openBatch(trigger, entries.length);
    const reload = entries.length > 0 && (fullReload || errorRecovery);
    if (reload) startReload();
    for (const [file, events] of entries) {
      for (const event of events) originalEmit(event, file);
    }
    if (errorRecovery && entries.length === 0) sendRaw({ type: "full-reload", path: "*" });
    if (trigger === "timeout") {
      server.config.logger.warn(
        `${LOG_TAG} HMR gate was paused longer than allowed; released ${entries.length} file(s).`,
      );
    }
    return { entries, heldMs, errorRecovery };
  }

  function isHeld(event, file) {
    if (!held.has(event) || typeof file !== "string") return false;
    const normalized = file.replaceAll("\\", "/");
    return !passthrough.some((part) => normalized.includes(part));
  }

  async function handleControl(req, res, path) {
    if (!isTrustedControlRequest(req, token)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    if (path === HMR_GATE_PATH && req.method === "GET") {
      return sendJson(res, 200, describe());
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    const body = await readJson(req, 4096, { allowEmpty: true });
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const input = isPlainObject(body.value) ? body.value : {};
    const action = path === HMR_FLUSH_PATH ? "flush" : (input.action ?? "status");

    if (action === "pause") {
      gate.pause({ reason: input.reason, timeoutMs: input.timeoutMs });
      broadcast(HMR_GATE_EVENT, gate.status());
      return sendJson(res, 200, describe());
    }
    if (action === "resume" || action === "flush") {
      const { entries, heldMs, errorRecovery } = flush("flush");
      return sendJson(res, 200, {
        ...describe(),
        flushed: entries.map(([file]) => file),
        count: entries.length,
        heldMs,
        errorRecovery,
      });
    }
    if (action === "status") return sendJson(res, 200, describe());
    return sendJson(res, 400, { error: "unknown_action", actions: ["pause", "resume", "status"] });
  }

  function describe() {
    return {
      enabled: !bundled,
      mode: fullReload ? "full-reload" : "granular",
      maxHoldMs,
      ...gate.status(),
    };
  }

  return {
    name: "seemodo:hmr-gate",
    apply: "serve",

    configResolved(config) {
      bundled = config.experimental?.bundledDev === true;
    },

    configureServer(srv) {
      server = srv;
      const ws = srv.ws;
      broadcast = (event, data) => {
        try {
          ws.send({ type: "custom", event, data });
        } catch {
          // no clients / closing
        }
      };

      ws.on?.("vite:client:connect", (_data, client) => {
        try {
          client?.send?.(DEV_SERVER_MODE_EVENT, {
            mode: bundled ? "bundled" : "classic",
            hmr: fullReload ? "full-reload" : "granular",
            gate: !bundled,
            startedAt: new Date(startedAt).toISOString(),
          });
          client?.send?.(BOOT_PROGRESS_EVENT, bootData());
          if (gate.paused) client?.send?.(HMR_GATE_EVENT, gate.status());
        } catch {
          // client went away
        }
      });

      // Endpoints (status answers even when the gate itself is inactive).
      srv.middlewares.use((req, res, next) => {
        const path = pathnameOf(req);
        if (path !== HMR_GATE_PATH && path !== HMR_FLUSH_PATH) return next();
        if (bundled) return sendJson(res, 200, describe());
        handleControl(req, res, path).catch((error) => {
          sendJson(res, 500, { error: String(error?.message ?? error) });
        });
      });

      if (bundled) {
        srv.config.logger.warn(
          `${LOG_TAG} HMR gate is not available with experimental.bundledDev; file events pass through.`,
        );
        return;
      }

      // Hold watcher events while paused.
      const watcher = srv.watcher;
      originalEmit = watcher.emit.bind(watcher);
      watcher.emit = (event, ...args) => {
        if (gate.paused && isHeld(event, args[0])) {
          gate.hold(event, args[0]);
          return true;
        }
        if (!gate.paused && batch === undefined && isHeld(event, args[0])) openBatch("watch", 1);
        return originalEmit(event, ...args);
      };
      restoreSends.push(() => {
        watcher.emit = originalEmit;
      });

      // Coalesce Vite's own updates into one reload right after a flush (fullReload mode).
      const targets = new Set([ws, srv.environments?.client?.hot].filter((t) => t?.send));
      let first = true;
      for (const target of targets) {
        const original = target.send.bind(target);
        if (first) sendRaw = original;
        first = false;
        target.send = (...args) => {
          const frame = args[0];
          if (coalescing && (frame?.type === "update" || frame?.type === "full-reload")) {
            extendReload();
            return;
          }
          return original(...args);
        };
        restoreSends.push(() => {
          target.send = original;
        });
      }

      // A 5xx page served while paused means the browser may show a broken
      // state; the next flush then ends with a full reload.
      srv.middlewares.use((req, res, next) => {
        if (
          gate.paused &&
          req.method === "GET" &&
          (req.headers.accept ?? "").includes("text/html")
        ) {
          res.on("finish", () => {
            if (res.statusCode >= 500) gate.noteErrorPage();
          });
        }
        next();
      });

      if (options.startPaused) gate.pause({ reason: "start", timeoutMs: maxHoldMs });
    },

    transform(_code, id, transformOptions) {
      const name = this.environment?.name ?? (transformOptions?.ssr ? "ssr" : "client");
      const now = Date.now();
      let entry = modules.get(name);
      if (!entry) {
        entry = { ids: new Set(), lastAt: 0 };
        modules.set(name, entry);
      }
      entry.ids.add(id);
      entry.lastAt = now;
      scheduleBoot();
      if (batch) {
        const ids = batch.ids.get(name) ?? new Set();
        ids.add(id);
        batch.ids.set(name, ids);
        batch.lastAt = now;
        scheduleBatch();
        settleBatch(SETTLE_AFTER_TRANSFORM_MS);
      }
      return null;
    },

    buildStart() {
      buildErrors.delete(this.environment?.name ?? "shared");
      scheduleBoot();
    },

    buildEnd(error) {
      const name = this.environment?.name ?? "shared";
      const summary = firstBuildError(error);
      if (summary) buildErrors.set(name, summary);
      else buildErrors.delete(name);
      scheduleBoot();
    },

    closeWatcher() {
      gate.dispose();
      for (const restore of restoreSends.splice(0)) restore();
      for (const t of [bootTimer, batchTimer, settleTimer, reloadTimer]) if (t) clearTimeout(t);
      bootTimer = batchTimer = settleTimer = reloadTimer = undefined;
      coalescing = false;
      batch = undefined;
      server = undefined;
      originalEmit = undefined;
    },

    /** Programmatic access (tests, custom integrations). */
    api: {
      pause: (opts) => gate.pause(opts),
      flush: (trigger) => flush(trigger),
      status: () => describe(),
    },
  };
}

export default hmrGatePlugin;
