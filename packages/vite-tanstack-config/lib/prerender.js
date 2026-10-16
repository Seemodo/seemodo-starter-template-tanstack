// Prerendering (static HTML for selected routes) with Nitro builds.
//
// TanStack Start prerenders after the build by starting `vite preview` with the
// same config and fetching each page. Two things need help with Nitro:
//
// 1. Nitro's preview for the Cloudflare preset spawns `wrangler dev`. During the
//    prerender pass (TSS_PRERENDERING=true) Nitro is therefore left out and
//    TanStack Start's own preview middleware serves the pages instead.
// 2. That middleware imports `<ssr outDir>/<server entry>.js` and calls
//    `.fetch(request)`. Nitro wrote the real server elsewhere (.output/server),
//    as a Cloudflare module worker whose fetch takes `(request, env, ctx)`. A
//    small adapter module is generated at the expected path; it lives under
//    node_modules/.seemodo, never in the deployable output.
//
// Inside a Seemodo sandbox build the prerender output shape is pinned so the
// publish step finds `<route>/index.html` files in .output/public, and a
// `[seemodo-prerender-report]` summarizes which routes rendered.
//
// Copyright (c) 2026 Seemodo. MIT License.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PRERENDER_REPORT_MARKER, prerenderReportPayload, writeReport } from "./diagnostics.js";
import { warn } from "./sandbox.js";

export const PRERENDER_ENV = "TSS_PRERENDERING";
export const PRERENDER_SERVER_DIR = "node_modules/.seemodo/prerender-server";

/** Mirrors TanStack Start's rule for whether the post-build prerender pass runs. */
export function isPrerenderEnabled(startOptions) {
  if (!startOptions || typeof startOptions !== "object") return false;
  const spa = startOptions.spa;
  if (spa && typeof spa === "object" && spa.enabled !== false) return true;
  const prerender = startOptions.prerender;
  if (prerender?.enabled === false) return false;
  if (typeof prerender?.enabled === "boolean") return prerender.enabled;
  const pages = Array.isArray(startOptions.pages) ? startOptions.pages : [];
  return pages.some((page) => page && typeof page === "object" && page.prerender?.enabled === true);
}

/** True while TanStack Start runs `vite preview` for its prerender pass. */
export function isPrerenderPreview(configEnv, env = process.env) {
  return Boolean(configEnv.isPreview) && env[PRERENDER_ENV] === "true";
}

// Options that would move files away from <route>/index.html or fail the publish.
const PINNED = { autoSubfolderIndex: true, failOnError: false };

function pinned(source, where, notes) {
  const next = { ...source };
  for (const [key, value] of Object.entries(PINNED)) {
    if (key === "failOnError" && where !== "prerender") continue; // root-level only
    if (key in next && next[key] !== value) notes.push(`${where}.${key}`);
    next[key] = value;
  }
  if ("outputPath" in next) {
    notes.push(`${where}.outputPath`);
    delete next.outputPath;
  }
  return next;
}

/**
 * Sandbox builds: pins the output shape and tracks which routes rendered.
 * Returns the options to pass to `tanstackStart()` and a plugin that prints the
 * `[seemodo-prerender-report]` after the build.
 */
export function prepareSandboxPrerender(startOptions) {
  const attempted = new Set();
  const rendered = new Set();
  const notes = [];
  const userPrerender = startOptions.prerender ?? {};

  const track = (original) => (context) => {
    if (context?.page?.path !== undefined) rendered.add(context.page.path);
    return typeof original === "function" ? original(context) : undefined;
  };

  const prerender = pinned(userPrerender, "prerender", notes);
  const userFilter = userPrerender.filter;
  prerender.filter = (page) => {
    const keep = typeof userFilter === "function" ? userFilter(page) : true;
    if (keep) attempted.add(page.path);
    return keep;
  };
  prerender.onSuccess = track(userPrerender.onSuccess);

  const options = { ...startOptions, prerender };
  if (Array.isArray(startOptions.pages)) {
    options.pages = startOptions.pages.map((page) => {
      if (!page || typeof page !== "object" || !page.prerender) return page;
      const pagePrerender = pinned(page.prerender, `pages["${page.path}"].prerender`, notes);
      if ("onSuccess" in pagePrerender) pagePrerender.onSuccess = track(pagePrerender.onSuccess);
      return { ...page, prerender: pagePrerender };
    });
  }
  if (startOptions.spa && typeof startOptions.spa.prerender?.onSuccess === "function") {
    options.spa = {
      ...startOptions.spa,
      prerender: {
        ...startOptions.spa.prerender,
        onSuccess: track(startOptions.spa.prerender.onSuccess),
      },
    };
  }
  if (notes.length > 0) {
    warn(
      `inside a Seemodo sandbox build these prerender options are fixed: ${notes.join(", ")} ` +
        "(pages are written as <route>/index.html and failed routes fall back to SSR).",
    );
  }

  const reporter = {
    name: "seemodo:prerender-report",
    apply: "build",
    enforce: "post",
    buildApp: {
      order: "post",
      handler() {
        if (attempted.size === 0) return;
        const failed = [...attempted].filter((route) => !rendered.has(route));
        writeReport(
          PRERENDER_REPORT_MARKER,
          prerenderReportPayload({ attempted: attempted.size, rendered: rendered.size, failed }),
        );
        if (failed.length > 0) {
          warn(
            `${failed.length} route(s) could not be prerendered and will be server-rendered: ${failed.join(", ")}`,
          );
        }
      },
    },
  };
  return { options, reporter };
}

/** Source of the adapter module served to TanStack Start's preview middleware. */
export function prerenderAdapterSource(workerUrl, vars) {
  return `// Generated by @seemodo/vite-tanstack-config for the prerender pass. Do not edit.
import worker from ${JSON.stringify(workerUrl)};

const env = ${JSON.stringify(vars)};
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };

export default {
  fetch(incoming) {
    // Hand the worker a plain WHATWG Request: Node adapter requests can carry
    // read-only fields the Cloudflare handler writes to.
    const init = { method: incoming.method, headers: incoming.headers };
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      init.body = incoming.body;
      init.duplex = "half";
    }
    return worker.fetch(new Request(incoming.url, init), env, ctx);
  },
};
`;
}

function readVars(serverDir) {
  try {
    const vars = JSON.parse(readFileSync(path.join(serverDir, "wrangler.json"), "utf8"))?.vars;
    return vars && typeof vars === "object" && !Array.isArray(vars) ? vars : {};
  } catch {
    return {};
  }
}

function workerEntry(serverDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(serverDir, "..", "package.json"), "utf8"));
    if (typeof pkg.main === "string") {
      const candidate = path.resolve(serverDir, "..", pkg.main);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through to the usual file names
  }
  return ["index.mjs", "index.js"].map((f) => path.join(serverDir, f)).find((f) => existsSync(f));
}

/**
 * Plugin for the prerender preview pass: points the SSR output directory at a
 * scratch folder and writes the adapter there before TanStack Start's preview
 * middleware loads it.
 *
 * @param {() => string[]} serverDirs  candidate Nitro server output directories (relative to root)
 */
export function prerenderServerPlugin(serverDirs) {
  return {
    name: "seemodo:prerender-server",
    config(userConfig, { isPreview }) {
      if (!isPreview) return undefined;
      const outDir = path.resolve(userConfig.root ?? process.cwd(), PRERENDER_SERVER_DIR);
      return {
        environments: { ssr: { build: { outDir } } },
        preview: { host: "127.0.0.1", strictPort: false },
      };
    },
    configResolved(config) {
      const ssrBuild = config.environments?.ssr?.build;
      const input = (ssrBuild?.rolldownOptions ?? ssrBuild?.rollupOptions)?.input ?? "server";
      if (typeof input !== "string") {
        warn("prerendering skipped: the SSR build input is not a single entry.");
        return;
      }
      const serverDir = serverDirs()
        .map((dir) => path.resolve(config.root, dir))
        .find((dir) => workerEntry(dir));
      if (!serverDir) {
        warn("prerendering cannot start: no Nitro server build found in .output/server.");
        return;
      }
      const target = path.resolve(config.root, ssrBuild?.outDir ?? PRERENDER_SERVER_DIR);
      const file = path.join(target, `${path.basename(input, path.extname(input))}.js`);
      mkdirSync(target, { recursive: true });
      const workerUrl = pathToFileURL(workerEntry(serverDir)).href;
      writeFileSync(file, prerenderAdapterSource(workerUrl, readVars(serverDir)));
    },
  };
}
