import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig, envDefines, isSeemodoSandbox, normalizeInput } from "../index.js";

const serve = { command: "serve", mode: "development", isPreview: false };
const build = { command: "build", mode: "production", isPreview: false };

function pluginNames(config) {
  return config.plugins
    .flat(Infinity)
    .filter(Boolean)
    .map((p) => p.name);
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe("normalizeInput", () => {
  it("keeps an options object as is", async () => {
    const options = { nitro: false, hmrGate: true, vite: { base: "/x/" } };
    expect(await normalizeInput(options, serve)).toEqual(options);
  });

  it("treats a plain Vite config as `vite`", async () => {
    expect(await normalizeInput({ server: { port: 3000 }, base: "/app/" }, serve)).toEqual({
      vite: { server: { port: 3000 }, base: "/app/" },
    });
  });

  it("splits mixed objects: known keys are options, the rest is Vite config", async () => {
    const plugin = { name: "x" };
    const result = await normalizeInput(
      { plugins: [plugin], nitro: false, build: { sourcemap: true } },
      serve,
    );
    expect(result.plugins).toEqual([plugin]);
    expect(result.nitro).toBe(false);
    expect(result.vite).toEqual({ build: { sourcemap: true } });
  });

  it("calls a config function with the Vite env", async () => {
    const result = await normalizeInput(
      (env) => ({ define: { MODE: JSON.stringify(env.mode) } }),
      serve,
    );
    expect(result).toEqual({ vite: { define: { MODE: '"development"' } } });
  });

  it("awaits a config promise", async () => {
    expect(await normalizeInput(Promise.resolve({ base: "/p/" }), serve)).toEqual({
      vite: { base: "/p/" },
    });
  });

  it("rejects other input types", async () => {
    await expect(normalizeInput(42, serve)).rejects.toThrow(TypeError);
  });
});

describe("isSeemodoSandbox", () => {
  it("reads SEEMODO_SANDBOX and SANDBOX_APP_DIR", () => {
    expect(isSeemodoSandbox({})).toBe(false);
    expect(isSeemodoSandbox({ SEEMODO_SANDBOX: "1" })).toBe(true);
    expect(isSeemodoSandbox({ SEEMODO_SANDBOX: "on" })).toBe(true);
    expect(isSeemodoSandbox({ SEEMODO_SANDBOX: "0" })).toBe(false);
    expect(isSeemodoSandbox({ SANDBOX_APP_DIR: "/home/app" })).toBe(true);
  });
});

describe("envDefines", () => {
  it("defines VITE_* values from .env files and the environment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seemodo-env-"));
    writeFileSync(path.join(dir, ".env"), "VITE_FROM_FILE=file\nSECRET=hidden\n");
    process.env.VITE_FROM_PROCESS = "process";
    const define = envDefines("production", dir);
    expect(define["import.meta.env.VITE_FROM_FILE"]).toBe('"file"');
    expect(define["import.meta.env.VITE_FROM_PROCESS"]).toBe('"process"');
    expect(Object.keys(define).some((key) => key.includes("SECRET"))).toBe(false);
  });
});

describe("defineConfig", () => {
  it("wraps a plain Vite config and still applies the defaults", async () => {
    delete process.env.SEEMODO_SANDBOX;
    delete process.env.SANDBOX_APP_DIR;
    const config = await defineConfig({ server: { port: 4000 } })(serve);
    expect(config.server.port).toBe(4000);
    expect(config.server.allowedHosts).toBe(true);
    expect(pluginNames(config)).toContain("seemodo:error-logger");
    expect(config.resolve.dedupe).toContain("react");
  });

  it("enables the HMR gate and dev server bridge only inside a sandbox by default", async () => {
    delete process.env.SEEMODO_SANDBOX;
    delete process.env.SANDBOX_APP_DIR;
    let names = pluginNames(await defineConfig({})(serve));
    expect(names).not.toContain("seemodo:hmr-gate");
    expect(names).not.toContain("seemodo:dev-server-bridge");

    process.env.SEEMODO_SANDBOX = "1";
    const config = await defineConfig({})(serve);
    names = pluginNames(config);
    expect(names).toContain("seemodo:hmr-gate");
    expect(names).toContain("seemodo:dev-server-bridge");
    expect(config.server.hmr).toEqual({ clientPort: 443, protocol: "wss" });
    expect(config.server.watch.ignored).toContain("**/.claude/**");

    names = pluginNames(await defineConfig({ hmrGate: false, devServerBridge: false })(serve));
    expect(names).not.toContain("seemodo:hmr-gate");
    expect(names).not.toContain("seemodo:dev-server-bridge");
  });

  it("can opt into the gate outside a sandbox", async () => {
    delete process.env.SEEMODO_SANDBOX;
    delete process.env.SANDBOX_APP_DIR;
    const names = pluginNames(await defineConfig({ hmrGate: { fullReload: true } })(serve));
    expect(names).toContain("seemodo:hmr-gate");
  });

  it("adds Nitro, diagnostics and the watchdog (last) to sandbox builds", async () => {
    process.env.SEEMODO_SANDBOX = "1";
    const names = pluginNames(await defineConfig({})(build));
    expect(names.some((n) => n.startsWith("nitro"))).toBe(true);
    expect(names).toContain("seemodo:build-report");
    expect(names).toContain("seemodo:wrangler-config-fix");
    expect(names.at(-1)).toBe("seemodo:build-exit-watchdog");
  });

  it("skips Nitro in dev and when disabled", async () => {
    delete process.env.SEEMODO_SANDBOX;
    delete process.env.SANDBOX_APP_DIR;
    expect(pluginNames(await defineConfig({})(serve)).some((n) => n.startsWith("nitro"))).toBe(
      false,
    );
    const names = pluginNames(await defineConfig({ nitro: false })(build));
    expect(names.some((n) => n.startsWith("nitro"))).toBe(false);
    expect(names).not.toContain("seemodo:build-exit-watchdog");
  });

  it("serves prerender pages through the adapter instead of Nitro's preview", async () => {
    delete process.env.SEEMODO_SANDBOX;
    delete process.env.SANDBOX_APP_DIR;
    process.env.TSS_PRERENDERING = "true";
    const names = pluginNames(
      await defineConfig({})({ command: "serve", mode: "production", isPreview: true }),
    );
    expect(names).toContain("seemodo:prerender-server");
    expect(names.some((n) => n.startsWith("nitro"))).toBe(false);
  });

  it("injects VITE_* defines unless envDefine is false", async () => {
    process.env.VITE_TEST_VALUE = "abc";
    expect((await defineConfig({})(serve)).define["import.meta.env.VITE_TEST_VALUE"]).toBe('"abc"');
    expect((await defineConfig({ envDefine: false })(serve)).define).toEqual({});
  });
});
