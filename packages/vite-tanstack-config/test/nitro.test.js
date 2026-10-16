import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NITRO_PRESET,
  defaultWorkerName,
  fixWranglerConfigFile,
  resolveNitro,
  serverDirCandidates,
  withoutImpliedCompatFlags,
} from "../lib/nitro.js";

function projectWithName(name, extraFiles = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "seemodo-nitro-"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  for (const [file, content] of Object.entries(extraFiles))
    writeFileSync(path.join(dir, file), content);
  return dir;
}

describe("resolveNitro", () => {
  const root = projectWithName("@acme/My App!");

  it("is off for `false`", () => {
    expect(resolveNitro({ option: false, sandbox: false, env: {}, root })).toEqual({
      enabled: false,
    });
  });

  it("defaults to a Cloudflare fallback that NITRO_PRESET and auto-detection can override", () => {
    const plan = resolveNitro({ option: undefined, sandbox: false, env: {}, root });
    expect(plan.enabled).toBe(true);
    expect(plan.required).toBe(false);
    expect(plan.config.preset).toBeUndefined();
    expect(plan.config.defaultPreset).toBe(DEFAULT_NITRO_PRESET);
    expect(plan.config.cloudflare.wrangler.name).toBe("my-app");
  });

  it("does not pin a worker name for a non-Cloudflare NITRO_PRESET", () => {
    const plan = resolveNitro({
      option: undefined,
      sandbox: false,
      env: { NITRO_PRESET: "vercel" },
      root,
    });
    expect(plan.config.cloudflare).toBeUndefined();
  });

  it("`true` and objects make nitro required", () => {
    expect(resolveNitro({ option: true, sandbox: false, env: {}, root }).required).toBe(true);
    const plan = resolveNitro({ option: { preset: "node-server" }, sandbox: false, env: {}, root });
    expect(plan.required).toBe(true);
    expect(plan.config.preset).toBe("node-server");
    expect(plan.config.defaultPreset).toBeUndefined();
  });

  it("SEEMODO_NITRO_PRESET pins the preset over the option", () => {
    const plan = resolveNitro({
      option: { preset: "node-server" },
      sandbox: false,
      env: { SEEMODO_NITRO_PRESET: "netlify" },
      root,
    });
    expect(plan.config.preset).toBe("netlify");
  });

  it("keeps the user's options (compatibilityDate, output) outside a sandbox", () => {
    const plan = resolveNitro({
      option: {
        compatibilityDate: "2026-09-01",
        output: { dir: "build" },
        cloudflare: { nodeCompat: false },
      },
      sandbox: false,
      env: {},
      root,
    });
    expect(plan.config.compatibilityDate).toBe("2026-09-01");
    expect(plan.config.output).toEqual({ dir: "build" });
    expect(plan.config.cloudflare.nodeCompat).toBe(false);
  });

  it("pins preset and output layout inside a sandbox", () => {
    const plan = resolveNitro({
      option: { preset: "vercel", output: { dir: "elsewhere" } },
      sandbox: true,
      env: { NITRO_PRESET: "netlify" },
      root,
    });
    expect(plan.required).toBe(true);
    expect(plan.config.preset).toBe("cloudflare-module");
    expect(plan.config.output).toEqual({
      dir: ".output",
      publicDir: ".output/public",
      serverDir: ".output/server",
    });
    expect(plan.config.cloudflare).toMatchObject({ nodeCompat: true, deployConfig: true });
  });

  it("respects an existing wrangler config instead of pinning the worker name", () => {
    const withWrangler = projectWithName("app", { "wrangler.jsonc": "{}" });
    const plan = resolveNitro({ option: undefined, sandbox: false, env: {}, root: withWrangler });
    expect(plan.config.cloudflare).toBeUndefined();
  });
});

describe("defaultWorkerName", () => {
  it("cleans and shortens the package name", () => {
    expect(defaultWorkerName(projectWithName("Seemodo_Starter.Template"))).toBe(
      "seemodo-starter-template",
    );
    expect(defaultWorkerName(projectWithName("a".repeat(80)))).toHaveLength(63);
    expect(defaultWorkerName(projectWithName("!!!"))).toBeUndefined();
  });
});

describe("serverDirCandidates", () => {
  it("resolves the {{ output.dir }} placeholder and prefers what Nitro reported", () => {
    const config = { output: { dir: "out", serverDir: "{{ output.dir }}/srv" } };
    expect(serverDirCandidates(config, { serverDir: "/abs/srv" })).toEqual([
      "/abs/srv",
      "out/srv",
      ".output/server",
    ]);
  });
});

describe("wrangler config fixer", () => {
  it("drops nodejs_compat flags once the compatibility date implies them", () => {
    expect(
      withoutImpliedCompatFlags({
        compatibility_date: "2026-08-04",
        compatibility_flags: ["nodejs_compat", "nodejs_compat_v2", "global_fetch_strictly_public"],
      }),
    ).toEqual({
      compatibility_date: "2026-08-04",
      compatibility_flags: ["global_fetch_strictly_public"],
    });
    expect(
      withoutImpliedCompatFlags({
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
      }),
    ).toEqual({ compatibility_date: "2026-10-01" });
  });

  it("leaves older dates, missing flags and odd input alone", () => {
    expect(
      withoutImpliedCompatFlags({
        compatibility_date: "2025-09-01",
        compatibility_flags: ["nodejs_compat"],
      }),
    ).toBeUndefined();
    expect(withoutImpliedCompatFlags({ compatibility_date: "2026-09-01" })).toBeUndefined();
    expect(
      withoutImpliedCompatFlags({
        compatibility_date: "soon",
        compatibility_flags: ["nodejs_compat"],
      }),
    ).toBeUndefined();
    expect(withoutImpliedCompatFlags(null)).toBeUndefined();
    expect(withoutImpliedCompatFlags([])).toBeUndefined();
  });

  it("rewrites the file only when something changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seemodo-wrangler-"));
    const file = path.join(dir, "wrangler.json");
    writeFileSync(
      file,
      JSON.stringify({
        compatibility_date: "2026-09-01",
        compatibility_flags: ["nodejs_compat"],
        main: "index.mjs",
      }),
    );
    expect(await fixWranglerConfigFile(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      compatibility_date: "2026-09-01",
      main: "index.mjs",
    });
    expect(await fixWranglerConfigFile(file)).toBe(false);
    writeFileSync(file, "not json");
    expect(await fixWranglerConfigFile(file)).toBe(false);
    expect(await fixWranglerConfigFile(path.join(dir, "missing.json"))).toBe(false);
  });
});
