import { describe, expect, it, vi } from "vitest";
import {
  compactDiagnostic,
  formatReport,
  prerenderReportPayload,
  buildErrorReportPayload,
  MAX_REPORT_CHARS,
} from "../lib/diagnostics.js";
import {
  DEFAULT_EXIT_GRACE_MS,
  MAX_EXIT_GRACE_MS,
  MIN_EXIT_GRACE_MS,
  buildExitWatchdogPlugin,
  resolveBuildExitWatchdog,
} from "../lib/watchdog.js";
import {
  isPrerenderEnabled,
  prepareSandboxPrerender,
  prerenderAdapterSource,
} from "../lib/prerender.js";
import { resolveAssetsProxy } from "../lib/assets-proxy.js";

describe("build exit watchdog", () => {
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("defaults to on with 60 s", () => {
    expect(resolveBuildExitWatchdog(undefined, {})).toEqual({
      enabled: true,
      graceMs: DEFAULT_EXIT_GRACE_MS,
    });
  });

  it("clamps the grace to 5 s–10 min", () => {
    expect(resolveBuildExitWatchdog({ graceMs: 10 }, {}).graceMs).toBe(MIN_EXIT_GRACE_MS);
    expect(resolveBuildExitWatchdog({ graceMs: 1e9 }, {}).graceMs).toBe(MAX_EXIT_GRACE_MS);
    expect(resolveBuildExitWatchdog({ graceMs: 30_000 }, {}).graceMs).toBe(30_000);
    expect(resolveBuildExitWatchdog({}, { SEEMODO_BUILD_EXIT_GRACE_MS: "1" }).graceMs).toBe(
      MIN_EXIT_GRACE_MS,
    );
    expect(resolveBuildExitWatchdog({}, { SEEMODO_BUILD_EXIT_GRACE_MS: "9999999" }).graceMs).toBe(
      MAX_EXIT_GRACE_MS,
    );
  });

  it("lets the environment win over the option", () => {
    expect(
      resolveBuildExitWatchdog({ graceMs: 30_000 }, { SEEMODO_BUILD_EXIT_GRACE_MS: "20000" })
        .graceMs,
    ).toBe(20_000);
    expect(
      resolveBuildExitWatchdog({ enabled: true }, { SEEMODO_BUILD_EXIT_WATCHDOG: "off" }).enabled,
    ).toBe(false);
    expect(resolveBuildExitWatchdog({ enabled: false }, {}).enabled).toBe(false);
    expect(resolveBuildExitWatchdog(false, {}).enabled).toBe(false);
  });

  it("ignores invalid values with a warning", () => {
    const warn = quiet();
    expect(resolveBuildExitWatchdog({ graceMs: -5 }, {}).graceMs).toBe(DEFAULT_EXIT_GRACE_MS);
    expect(resolveBuildExitWatchdog({}, { SEEMODO_BUILD_EXIT_GRACE_MS: "soon" }).graceMs).toBe(
      DEFAULT_EXIT_GRACE_MS,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("exits after the grace with a report", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const warn = quiet();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const plugin = buildExitWatchdogPlugin({ graceMs: 5_000 }, { exit });
    plugin.buildApp.handler();
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
    const text = stderr.mock.calls.map(([t]) => String(t)).join("");
    stderr.mockRestore();
    expect(text).toContain("[seemodo-build-exit-report]");
    warn.mockRestore();
    vi.useRealTimers();
  });
});

describe("diagnostics", () => {
  it("keeps small errors intact", () => {
    const error = Object.assign(new Error("Unexpected token"), {
      plugin: "vite:esbuild",
      loc: { file: "a.tsx", line: 2, column: 4 },
    });
    expect(compactDiagnostic(error)).toMatchObject({
      name: "Error",
      message: "Unexpected token",
      plugin: "vite:esbuild",
      loc: { line: 2 },
    });
  });

  it("always fits the size budget, even for huge and circular values", () => {
    const error = new Error("x".repeat(50_000));
    error.errors = Array.from({ length: 500 }, (_, i) => ({
      message: `nested ${i} ${"y".repeat(2000)}`,
      loc: { file: "f", line: i },
    }));
    error.cause = error;
    const payload = buildErrorReportPayload(error, "client");
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(payload).toMatchObject({ version: 1, kind: "build-error", environment: "client" });
  });

  it("handles primitives and odd objects", () => {
    expect(compactDiagnostic("boom")).toBe("boom");
    expect(compactDiagnostic(Symbol("s"))).toBe("Symbol(s)");
    expect(compactDiagnostic(new Map())).toBe("[Map]");
  });

  it("formats marker-wrapped reports", () => {
    expect(formatReport("seemodo-build-report", { a: 1 })).toBe(
      '\n[seemodo-build-report]\n{"a":1}\n[/seemodo-build-report]\n',
    );
  });

  it("bounds the prerender route list", () => {
    const failed = Array.from({ length: 80 }, (_, i) => `/r${i}${"z".repeat(300)}`);
    const payload = prerenderReportPayload({ attempted: 100, rendered: 20, failed });
    expect(payload.failed).toHaveLength(50);
    expect(payload.failedTotal).toBe(80);
    expect(payload.failed[0].length).toBeLessThan(230);
  });
});

describe("prerender", () => {
  it("detects whether prerendering runs", () => {
    expect(isPrerenderEnabled({})).toBe(false);
    expect(isPrerenderEnabled({ prerender: { enabled: true } })).toBe(true);
    expect(
      isPrerenderEnabled({
        prerender: { enabled: false },
        pages: [{ path: "/", prerender: { enabled: true } }],
      }),
    ).toBe(false);
    expect(isPrerenderEnabled({ pages: [{ path: "/", prerender: { enabled: true } }] })).toBe(true);
    expect(isPrerenderEnabled({ spa: { enabled: true } })).toBe(true);
  });

  it("pins the output shape in sandbox builds and tracks rendered routes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onSuccess = vi.fn();
    const { options } = prepareSandboxPrerender({
      prerender: {
        enabled: true,
        autoSubfolderIndex: false,
        outputPath: "/x",
        onSuccess,
        filter: (p) => p.path !== "/skip",
      },
      pages: [{ path: "/about", prerender: { enabled: true, outputPath: "/about.html" } }],
    });
    warn.mockRestore();
    expect(options.prerender).toMatchObject({
      enabled: true,
      autoSubfolderIndex: true,
      failOnError: false,
    });
    expect(options.prerender.outputPath).toBeUndefined();
    expect(options.pages[0].prerender.outputPath).toBeUndefined();
    expect(options.prerender.filter({ path: "/skip" })).toBe(false);
    expect(options.prerender.filter({ path: "/" })).toBe(true);
    options.prerender.onSuccess({ page: { path: "/" }, html: "" });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("generates an adapter that calls the worker with env and ctx", () => {
    const source = prerenderAdapterSource("file:///app/.output/server/index.mjs", { A: "1" });
    expect(source).toContain('import worker from "file:///app/.output/server/index.mjs"');
    expect(source).toContain('{"A":"1"}');
    expect(source).toContain("worker.fetch(new Request(incoming.url, init), env, ctx)");
  });
});

describe("assets proxy", () => {
  it("is off unless both variables are set", () => {
    expect(resolveAssetsProxy({}).config).toBeUndefined();
    expect(resolveAssetsProxy({ SEEMODO_PREVIEW_HOST: "p.example.com" }).config).toBeUndefined();
  });
  it("validates host and path", () => {
    expect(
      resolveAssetsProxy({
        SEEMODO_PREVIEW_HOST: "https://p.example.com",
        SEEMODO_ASSETS_PATH: "/a/",
      }).error,
    ).toBeDefined();
    expect(
      resolveAssetsProxy({ SEEMODO_PREVIEW_HOST: "p.example.com", SEEMODO_ASSETS_PATH: "a" }).error,
    ).toBeDefined();
    expect(
      resolveAssetsProxy({
        SEEMODO_PREVIEW_HOST: "p.example.com:8443",
        SEEMODO_ASSETS_PATH: "/__seemodo/assets",
      }).config,
    ).toEqual({
      host: "p.example.com",
      port: 8443,
      prefix: "/__seemodo/assets/",
    });
  });
});
