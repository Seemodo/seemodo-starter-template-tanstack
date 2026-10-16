import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HMR_GATE_EVENT, createGateState, hmrGatePlugin, resolveFullReload } from "../hmr-gate.js";
import { fakeServer } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createGateState", () => {
  const noHash = () => undefined;

  it("passes events through while open", () => {
    const gate = createGateState({ hash: noHash });
    expect(gate.hold("change", "/a.ts")).toBe(false);
    expect(gate.status().state).toBe("open");
  });

  it("queues events per file while paused and releases them in order", () => {
    const gate = createGateState({ hash: noHash });
    gate.pause({ reason: "agent" });
    expect(gate.hold("add", "/b.ts")).toBe(true);
    expect(gate.hold("change", "/a.ts")).toBe(true);
    expect(gate.hold("change", "/a.ts")).toBe(true);
    expect(gate.hold("unlink", "/b.ts")).toBe(true);
    const status = gate.status();
    expect(status).toMatchObject({ state: "paused", reason: "agent", pendingCount: 2, pauses: 1 });
    const { entries } = gate.release();
    expect(entries).toEqual([
      ["/b.ts", ["add", "unlink"]],
      ["/a.ts", ["change"]],
    ]);
    expect(gate.status()).toMatchObject({ state: "open", pendingCount: 0, flushes: 1 });
  });

  it("drops a rewrite whose content equals the last released version", () => {
    let content = "v1";
    const gate = createGateState({ hash: () => content });
    gate.pause();
    gate.hold("change", "/a.ts");
    gate.release();
    gate.pause();
    expect(gate.hold("change", "/a.ts")).toBe(true);
    expect(gate.status().pendingCount).toBe(0);
    content = "v2";
    gate.hold("change", "/a.ts");
    expect(gate.status().pendingCount).toBe(1);
  });

  it("expires a pause after its timeout (clamped to maxHoldMs)", () => {
    const onExpire = vi.fn();
    const gate = createGateState({ maxHoldMs: 10_000, onExpire, hash: noHash });
    gate.pause({ timeoutMs: 999_999 });
    vi.advanceTimersByTime(9_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledWith("timeout");
  });

  it("re-pausing extends the deadline and keeps the queue", () => {
    const onExpire = vi.fn();
    const gate = createGateState({ maxHoldMs: 60_000, onExpire, hash: noHash });
    gate.pause({ timeoutMs: 5_000 });
    gate.hold("change", "/a.ts");
    vi.advanceTimersByTime(4_000);
    gate.pause({ timeoutMs: 5_000 });
    vi.advanceTimersByTime(4_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(gate.status()).toMatchObject({ pendingCount: 1, pauses: 1 });
  });

  it("enforces a 1 s minimum pause", () => {
    const onExpire = vi.fn();
    const gate = createGateState({ onExpire, hash: noHash });
    gate.pause({ timeoutMs: 1 });
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalled();
  });

  it("remembers an error page served while paused", () => {
    const gate = createGateState({ hash: noHash });
    gate.noteErrorPage();
    expect(gate.status().errorRecovery).toBe(false);
    gate.pause();
    gate.noteErrorPage();
    expect(gate.release().errorRecovery).toBe(true);
  });
});

describe("resolveFullReload", () => {
  it("prefers the option, then SEEMODO_HMR_FULL_RELOAD", () => {
    expect(resolveFullReload(true, {})).toBe(true);
    expect(resolveFullReload(false, { SEEMODO_HMR_FULL_RELOAD: "1" })).toBe(false);
    expect(resolveFullReload(undefined, { SEEMODO_HMR_FULL_RELOAD: "true" })).toBe(true);
    expect(resolveFullReload(undefined, {})).toBe(false);
  });
});

describe("hmrGatePlugin", () => {
  function setup(options = {}) {
    const fake = fakeServer();
    const plugin = hmrGatePlugin({ token: "", ...options });
    plugin.configResolved({ experimental: {} });
    plugin.configureServer(fake.server);
    return { fake, plugin };
  }

  it("holds watcher events while paused and replays them on flush", async () => {
    const { fake } = setup();
    const pause = await fake.request({
      url: "/__seemodo/hmr-gate",
      body: { action: "pause", reason: "write" },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ state: "paused", reason: "write" });
    expect(fake.sent.some((p) => p.event === HMR_GATE_EVENT)).toBe(true);

    fake.server.watcher.emit("change", "/app/src/a.tsx");
    fake.server.watcher.emit("add", "/app/src/b.tsx");
    fake.server.watcher.emit("change", "/app/node_modules/.vite/deps/x.js");
    expect(fake.emitted).toEqual([["change", "/app/node_modules/.vite/deps/x.js"]]);

    const flush = await fake.request({ url: "/__seemodo/hmr-flush" });
    expect(flush.json()).toMatchObject({ state: "open", count: 2 });
    expect(fake.emitted.slice(1)).toEqual([
      ["change", "/app/src/a.tsx"],
      ["add", "/app/src/b.tsx"],
    ]);
  });

  it("answers status on GET and rejects unknown actions", async () => {
    const { fake } = setup();
    const status = await fake.request({ method: "GET", url: "/__seemodo/hmr-gate" });
    expect(status.json()).toMatchObject({ enabled: true, state: "open", mode: "granular" });
    const bad = await fake.request({ url: "/__seemodo/hmr-gate", body: { action: "explode" } });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses requests from proxies, browsers and without the token", async () => {
    const { fake } = setup();
    const proxied = await fake.request({
      url: "/__seemodo/hmr-gate",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(proxied.statusCode).toBe(403);
    const browser = await fake.request({
      url: "/__seemodo/hmr-gate",
      headers: { origin: "https://x.example" },
    });
    expect(browser.statusCode).toBe(403);
    const remote = await fake.request({ url: "/__seemodo/hmr-gate", remoteAddress: "10.0.0.8" });
    expect(remote.statusCode).toBe(403);

    const secured = setup({ token: "s3cret" }).fake;
    const wrong = await secured.request({
      url: "/__seemodo/hmr-gate",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(403);
    const right = await secured.request({
      url: "/__seemodo/hmr-gate",
      remoteAddress: "10.0.0.8",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(right.statusCode).toBe(200);
  });

  it("flushes by itself when a pause times out", async () => {
    const { fake } = setup({ maxHoldMs: 5_000 });
    await fake.request({ url: "/__seemodo/hmr-gate", body: { action: "pause" } });
    fake.server.watcher.emit("change", "/app/src/a.tsx");
    expect(fake.emitted).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(fake.emitted).toEqual([["change", "/app/src/a.tsx"]]);
  });

  it("coalesces Vite's updates after a flush into one full reload in fullReload mode", async () => {
    const { fake, plugin } = setup({ fullReload: true });
    plugin.api.pause();
    fake.server.watcher.emit("change", "/app/src/a.tsx");
    plugin.api.flush();
    fake.server.ws.send({ type: "update", updates: [] });
    fake.server.ws.send({ type: "update", updates: [] });
    expect(fake.sent.filter((p) => p.type === "update")).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(fake.sent.filter((p) => p.type === "full-reload")).toHaveLength(1);
    fake.server.ws.send({ type: "update", updates: [] });
    expect(fake.sent.filter((p) => p.type === "update")).toHaveLength(1);
  });

  it("restores the watcher when closed", () => {
    const { fake, plugin } = setup();
    const wrapped = fake.server.watcher.emit;
    plugin.closeWatcher();
    expect(fake.server.watcher.emit).not.toBe(wrapped);
  });
});
