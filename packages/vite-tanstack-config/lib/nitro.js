// Nitro (deploy target) option handling and the wrangler config fixer.
// Copyright (c) 2026 Seemodo. MIT License.

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { warn } from "./sandbox.js";

export const DEFAULT_NITRO_PRESET = "cloudflare-module";
export const DEFAULT_COMPATIBILITY_DATE = "2025-09-01";
export const NITRO_PRESET_ENV = "SEEMODO_NITRO_PRESET";

/** Output layout the Seemodo publish step reads (`assembleTanStackDist`). */
export const SANDBOX_OUTPUT = Object.freeze({
  dir: ".output",
  publicDir: ".output/public",
  serverDir: ".output/server",
});

/**
 * Cloudflare compatibility date from which `nodejs_compat` / `nodejs_compat_v2`
 * are on by default and the flags have no effect (Cloudflare changelog, 2026-08-04).
 */
export const NODEJS_COMPAT_IMPLIED_FROM = "2026-08-04";
const IMPLIED_FLAGS = new Set(["nodejs_compat", "nodejs_compat_v2"]);

const WRANGLER_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

/**
 * Cloudflare worker names: lowercase letters, digits and dashes, at most 63
 * characters. Nitro's own fallback (git remote or package name plus the path
 * below the detected workspace) can exceed that, so pin it to the package name
 * unless the app brings its own wrangler config.
 */
export function defaultWorkerName(root) {
  if (WRANGLER_FILES.some((file) => existsSync(path.join(root, file)))) return undefined;
  try {
    const { name } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (typeof name !== "string") return undefined;
    const clean = name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/, "");
    return clean || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides whether and how Nitro runs.
 *
 * @param {object} input
 * @param {undefined | boolean | object} input.option  the `nitro` option
 * @param {boolean} input.sandbox  inside a Seemodo sandbox
 * @param {Record<string, string | undefined>} input.env
 * @param {string} input.root  project root (for the worker name)
 * @returns {{ enabled: false } | { enabled: true, required: boolean, config: object, preset: string | undefined }}
 */
export function resolveNitro({ option, sandbox, env, root }) {
  if (option === false) return { enabled: false };
  const explicit = option === true || (option !== null && typeof option === "object");
  const user = option && typeof option === "object" ? { ...option } : {};
  const pinned = env[NITRO_PRESET_ENV]?.trim() || undefined;

  const config = { compatibilityDate: DEFAULT_COMPATIBILITY_DATE, ...user };
  let preset;

  if (sandbox) {
    // The platform build: the publish step expects the Cloudflare module layout.
    preset = pinned ?? DEFAULT_NITRO_PRESET;
    if (user.preset && user.preset !== preset) {
      warn(
        `nitro.preset "${user.preset}" is ignored inside a Seemodo sandbox build; using "${preset}".`,
      );
    }
    for (const name of ["NITRO_PRESET", "SERVER_PRESET"]) {
      if (env[name] && env[name] !== preset) {
        warn(`${name}="${env[name]}" is ignored inside a Seemodo sandbox build.`);
      }
    }
    config.preset = preset;
    delete config.defaultPreset;
    if (user.output) {
      warn("nitro.output is ignored inside a Seemodo sandbox build; writing to .output/.");
    }
    config.output = { ...SANDBOX_OUTPUT };
    if (preset.startsWith("cloudflare")) {
      config.cloudflare = { ...user.cloudflare, nodeCompat: true, deployConfig: true };
    }
  } else if (pinned ?? user.preset) {
    preset = pinned ?? user.preset;
    config.preset = preset;
  } else {
    // No explicit target: NITRO_PRESET and Nitro's provider auto-detection
    // (Vercel, Netlify, Cloudflare Pages, ...) still win over this fallback.
    delete config.preset;
    config.defaultPreset = user.defaultPreset ?? DEFAULT_NITRO_PRESET;
  }

  const target = preset ?? env.NITRO_PRESET ?? env.SERVER_PRESET ?? config.defaultPreset;
  const cloudflareTarget = typeof target === "string" && target.startsWith("cloudflare");
  if (cloudflareTarget && !config.cloudflare?.wrangler?.name) {
    const name = defaultWorkerName(root);
    if (name) {
      config.cloudflare = {
        ...config.cloudflare,
        wrangler: { ...config.cloudflare?.wrangler, name },
      };
    }
  }

  return { enabled: true, required: explicit || sandbox, config, preset };
}

/**
 * Registers a Nitro module that records the final server output directory, so
 * later build steps do not have to guess it.
 */
export function trackNitroOutput(config) {
  const seen = { serverDir: undefined, publicDir: undefined };
  const capture = (nitro) => {
    nitro.hooks.hook("compiled", (instance) => {
      seen.serverDir = instance.options.output.serverDir;
      seen.publicDir = instance.options.output.publicDir;
    });
  };
  config.modules = [...(config.modules ?? []), capture];
  return seen;
}

/** Candidate server output directories for a resolved Nitro config, most specific first. */
export function serverDirCandidates(config, seen) {
  const out = config.output ?? {};
  const dir = typeof out.dir === "string" ? out.dir : ".output";
  const fromConfig =
    typeof out.serverDir === "string"
      ? out.serverDir.replace(/\{\{\s*output\.dir\s*\}\}/g, dir)
      : path.join(dir, "server");
  return [...new Set([seen?.serverDir, fromConfig, ".output/server"].filter(Boolean))].filter(
    (candidate) => !candidate.includes("{{"),
  );
}

/**
 * Removes compatibility flags that the compatibility date already implies.
 * Returns the cleaned config, or `undefined` when nothing changes.
 */
export function withoutImpliedCompatFlags(wrangler) {
  if (!wrangler || typeof wrangler !== "object" || Array.isArray(wrangler)) return undefined;
  const date = wrangler.compatibility_date;
  const flags = wrangler.compatibility_flags;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (date < NODEJS_COMPAT_IMPLIED_FROM || !Array.isArray(flags)) return undefined;
  const kept = flags.filter((flag) => !IMPLIED_FLAGS.has(flag));
  if (kept.length === flags.length) return undefined;
  const next = { ...wrangler };
  if (kept.length > 0) next.compatibility_flags = kept;
  else delete next.compatibility_flags;
  return next;
}

/** Applies `withoutImpliedCompatFlags` to a wrangler.json file. Returns true when it was rewritten. */
export async function fixWranglerConfigFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return false;
  }
  const next = withoutImpliedCompatFlags(parsed);
  if (!next) return false;
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

/**
 * Vite plugin: after the whole build, drops `nodejs_compat` / `nodejs_compat_v2`
 * from Nitro's generated wrangler.json when the compatibility date already
 * implies them.
 */
export function wranglerConfigFixPlugin(config, seen) {
  let root = process.cwd();
  return {
    name: "seemodo:wrangler-config-fix",
    apply: "build",
    enforce: "post",
    configResolved(resolved) {
      root = resolved.root;
    },
    buildApp: {
      order: "post",
      async handler() {
        for (const dir of serverDirCandidates(config, seen)) {
          const file = path.resolve(root, dir, "wrangler.json");
          if (!existsSync(file)) continue;
          await fixWranglerConfigFile(file);
          return;
        }
      },
    },
  };
}
