import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createErrorCollector,
  devServerBridgePlugin,
  executeInViewers,
  normalizeBrowserReport,
  parseExecuteRequest,
} from "../dev-server-bridge.js";
import { isTrustedControlRequest, readJson } from "../lib/http.js";
import { fakeRequest, fakeResponse, fakeServer } from "./helpers.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "seemodo-bridge-"));
}

async function post(collector, options) {
  const res = fakeResponse();
  await collector.handle(fakeRequest(options), res);
  await res.done;
  return res;
}

describe("readJson", () => {
  it("enforces the byte limit by header and by stream", async () => {
    const declared = await readJson(
      fakeRequest({ body: "{}", headers: { "content-length": "999" } }),
      10,
    );
    expect(declared).toEqual({ ok: false, status: 413, error: "body_too_large" });
    const streamed = await readJson(fakeRequest({ body: { text: "x".repeat(100) } }), 10);
    expect(streamed.status).toBe(413);
  });

  it("reports empty and invalid bodies", async () => {
    expect(await readJson(fakeRequest({}), 100)).toMatchObject({ ok: false, error: "empty_body" });
    expect(await readJson(fakeRequest({}), 100, { allowEmpty: true })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readJson(fakeRequest({ body: "{nope" }), 100)).toMatchObject({
      status: 400,
      error: "invalid_json",
    });
  });
});

describe("isTrustedControlRequest", () => {
  const req = (headers = {}, remoteAddress = "127.0.0.1") => ({
    headers,
    socket: { remoteAddress },
  });
  it("accepts direct loopback requests only", () => {
    expect(isTrustedControlRequest(req(), "")).toBe(true);
    expect(isTrustedControlRequest(req({}, "::1"), "")).toBe(true);
    expect(isTrustedControlRequest(req({}, "172.17.0.2"), "")).toBe(false);
    expect(isTrustedControlRequest(req({ "x-forwarded-for": "1.1.1.1" }), "")).toBe(false);
    expect(isTrustedControlRequest(req({ origin: "http://127.0.0.1:5173" }), "")).toBe(false);
    expect(isTrustedControlRequest(req({ "sec-fetch-mode": "cors" }), "")).toBe(false);
  });
  it("requires the token when one is configured", () => {
    expect(isTrustedControlRequest(req(), "t0ken")).toBe(false);
    expect(isTrustedControlRequest(req({ "x-seemodo-token": "t0ken" }, "8.8.8.8"), "t0ken")).toBe(
      true,
    );
    expect(isTrustedControlRequest(req({ authorization: "Bearer t0ken" }), "t0ken")).toBe(true);
    expect(isTrustedControlRequest(req({ authorization: "Bearer t0ke" }), "t0ken")).toBe(false);
  });
});

describe("error collector", () => {
  it("writes [seemodo:error] lines and JSON lines to the log file", async () => {
    const root = tempRoot();
    const collector = createErrorCollector();
    collector.start(root);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const res = await post(collector, {
      body: {
        type: "runtime-error",
        message: "boom",
        stack: "Error: boom",
        line: 3,
        extra: "ignored",
      },
    });
    const written = stderr.mock.calls.map(([text]) => String(text));
    stderr.mockRestore();
    expect(res.statusCode).toBe(204);
    const line = written.find((t) => t.startsWith("[seemodo:error] "));
    expect(JSON.parse(line.slice("[seemodo:error] ".length))).toMatchObject({
      source: "browser",
      message: "boom",
      line: 3,
    });
    const logged = readFileSync(path.join(root, ".seemodo/dev-errors.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]);
    expect(entry).toMatchObject({ source: "browser", type: "runtime-error", message: "boom" });
    expect(entry.extra).toBeUndefined();
  });

  it("rejects oversized, invalid and non-object bodies", async () => {
    const collector = createErrorCollector({ outputFile: false, maxBodyBytes: 64 });
    expect((await post(collector, { body: { message: "x".repeat(200) } })).statusCode).toBe(413);
    expect((await post(collector, { body: "not json" })).statusCode).toBe(400);
    expect((await post(collector, { body: [1, 2] })).statusCode).toBe(400);
    expect((await post(collector, { method: "GET" })).statusCode).toBe(405);
  });

  it("rate limits bursts", async () => {
    const collector = createErrorCollector({ outputFile: false, maxReportsPerMinute: 2 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push((await post(collector, { body: { message: `m${i}` } })).statusCode);
    stderr.mockRestore();
    expect(codes).toEqual([204, 204, 429]);
  });

  it("validates its options", () => {
    expect(() => createErrorCollector({ endpoint: "//evil" })).toThrow();
    expect(() => createErrorCollector({ maxBodyBytes: 0 })).toThrow();
  });

  it("clips long fields", () => {
    const report = normalizeBrowserReport({ message: "m".repeat(10_000), line: -1 });
    expect(report.message.length).toBeLessThan(4100);
    expect(report.line).toBeUndefined();
    expect(report.type).toBe("runtime-error");
  });
});

describe("preview execute", () => {
  it("validates requests", () => {
    expect(parseExecuteRequest(null).error).toBeDefined();
    expect(parseExecuteRequest({ code: "  " }).error).toBeDefined();
    expect(parseExecuteRequest({ code: "x".repeat(40_000) }).error).toMatch(/limited/);
    expect(parseExecuteRequest({ code: "return 1", timeoutMs: 999_999 })).toEqual({
      code: "return 1",
      timeoutMs: 15_000,
    });
    expect(parseExecuteRequest({ code: "return 1" }).timeoutMs).toBe(3_000);
  });

  it("returns immediately without viewers", async () => {
    const ws = { clients: new Set(), send: vi.fn() };
    const result = await executeInViewers(ws, new Map(), { code: "1", timeoutMs: 100 });
    expect(result).toMatchObject({ viewers: 0, responded: 0, results: [] });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("collects one result per viewer and counts timeouts", async () => {
    const a = {};
    const b = {};
    const pending = new Map();
    const ws = {
      clients: new Set([a, b]),
      send: (payload) => {
        const collect = pending.get(payload.data.id);
        collect(a, { ok: true, result: { kind: "json", value: 1 } });
      },
    };
    const result = await executeInViewers(ws, pending, { code: "return 1", timeoutMs: 100 });
    expect(result).toMatchObject({ viewers: 2, responded: 1, timedOut: 1 });
    expect(pending.size).toBe(0);
  });

  it("is disabled outside a sandbox unless enabled", async () => {
    const fake = fakeServer();
    const plugin = devServerBridgePlugin({ errorCollector: false, previewExecute: false });
    plugin.configureServer(fake.server);
    const res = await fake.request({ url: "/__seemodo/preview-execute", body: { code: "1" } });
    expect(res.statusCode).toBe(404);
  });

  it("broadcasts restart announcements", async () => {
    const fake = fakeServer();
    const plugin = devServerBridgePlugin({ errorCollector: false });
    plugin.configureServer(fake.server);
    const res = await fake.request({
      url: "/__seemodo/restart-announce",
      body: { reason: "install" },
    });
    expect(res.json()).toMatchObject({ announced: true, reason: "install" });
    expect(fake.sent.at(-1)).toMatchObject({
      event: "seemodo:dev-server-restarting",
      data: { reason: "install" },
    });
    const denied = await fake.request({
      url: "/__seemodo/restart-announce",
      headers: { origin: "https://x" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("injects the client into Vite's HMR client only", () => {
    const plugin = devServerBridgePlugin({ errorCollector: false });
    const ctx = { environment: { config: { consumer: "client" } } };
    const out = plugin.transform.call(
      ctx,
      "x",
      "/root/node_modules/vite/dist/client/client.mjs",
      {},
    );
    expect(out.code).toContain('import("virtual:seemodo-dev-bridge")');
    expect(plugin.transform.call(ctx, "x", "/root/src/main.tsx", {})).toBeUndefined();
    expect(plugin.load("\0virtual:seemodo-dev-bridge")).toContain("startSeemodoDevBridge({");
  });
});
