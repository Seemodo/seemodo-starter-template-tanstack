# @seemodo/vite-tanstack-config

One-call Vite configuration for [Seemodo](https://seemodo.com) TanStack Start apps. It sets up the
toolchain, the dev server for Seemodo sandboxes and the production build for Cloudflare Workers, and
adds the hooks the Seemodo platform uses to watch a running app: an HMR gate, a browser error
collector, preview code execution and machine-readable build reports.

```ts
// vite.config.ts
import { defineConfig } from "@seemodo/vite-tanstack-config";

export default defineConfig({
  tanstackStart: { server: { entry: "server" } },
});
```

Plain ESM JavaScript with `.d.ts` types, no build step. Node.js 20.19+, Vite 7 or 8.

## What it sets up

- **TanStack Start** (`@tanstack/react-start/plugin/vite`), **React** (`@vitejs/plugin-react`) and
  **Tailwind CSS 4** (`@tailwindcss/vite`).
- **tsconfig paths**: Vite's native `resolve.tsconfigPaths` on Vite 8+, `vite-tsconfig-paths` on
  older Vite. **`@` → `src/`** alias and `resolve.dedupe` for React and TanStack.
- **Dev server**: host `0.0.0.0`, port from `--port` / `PORT` (default 5173), `strictPort`,
  `allowedHosts: true`. Inside a Seemodo sandbox (`SEEMODO_SANDBOX=1` or `SANDBOX_APP_DIR`) HMR runs
  through the HTTPS proxy (`wss`, port 443) and tool folders (`.claude`, `.agents`, `.workspace`) are
  not watched.
- **`VITE_*` defines** (`envDefine`): every `VITE_*` value from `.env*` files and the process
  environment is also defined as `import.meta.env.VITE_*`, for platforms that only pass env
  variables to the build process.
- **Structured error logging**: Vite, SSR, server-function, HTTP 5xx, process and build errors are
  written to stderr as single-line `[seemodo:error] {json}` records.
- **Nitro for builds** (`vite build`, `vite preview`), targeting **Cloudflare Workers**
  (`cloudflare-module`) by default. Output: `.output/public` (static assets), `.output/server`
  (`index.mjs` Worker, `wrangler.json`).
- **Prerendering** with Nitro (see below), **build reports**, a **build exit watchdog**, the
  **wrangler config fixer** and an optional **asset proxy**.
- **Editor bridge fallback** in dev: serves an empty `/seemodo.js` when the project has none.

## Options

| Option              | Default         | Description                                                                 |
| ------------------- | --------------- | --------------------------------------------------------------------------- |
| `tanstackStart`     | `{}`            | Options for TanStack Start (passed through; prerender pinned in sandbox).   |
| `react`             | `{}`            | Options for `@vitejs/plugin-react`.                                         |
| `nitro`             | `undefined`     | `undefined`, `true`, an options object, or `false`. See [Nitro](#nitro).    |
| `tailwind`          | `true`          | `false` disables Tailwind.                                                  |
| `tsconfigPaths`     | `"auto"`        | `"native"`, `"plugin"` or `false`.                                          |
| `envDefine`         | `true`          | `false` disables the `import.meta.env.VITE_*` defines.                      |
| `errorLogger`       | `true`          | `false` disables `[seemodo:error]` logging.                                 |
| `editorBridge`      | `true`          | `false` disables the `/seemodo.js` fallback.                                |
| `hmrGate`           | sandbox         | `false`, `true` or [options](#hmr-gate). On by default inside a sandbox.    |
| `devServerBridge`   | sandbox         | `false`, `true` or [options](#dev-server-bridge).                           |
| `buildDiagnostics`  | sandbox         | `[seemodo-build-report]` blocks for build errors.                           |
| `buildExitWatchdog` | `{}` (sandbox)  | `{ enabled, graceMs }` or `false`. See [watchdog](#build-exit-watchdog).    |
| `fixWranglerConfig` | `true`          | `false` keeps Nitro's wrangler.json untouched.                              |
| `assetsProxy`       | `true`          | `false` disables the [asset proxy](#asset-proxy) even when configured.      |
| `plugins`           | `[]`            | Extra Vite plugins, appended.                                               |
| `vite`              | `{}`            | Any Vite config, merged last with `mergeConfig`.                            |

`defineConfig` also accepts a plain Vite config, a Vite config function or a promise; the Seemodo
defaults still apply underneath. Keys that are not options above are treated as Vite config, so
`defineConfig({ server: { proxy: {...} }, nitro: false })` works too.

## Nitro

| `nitro`     | Behavior                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| `undefined` | On when `nitro` is installed. Falls back to `cloudflare-module` via Nitro's `defaultPreset`, so `NITRO_PRESET` and Nitro's provider detection (Vercel, Netlify, Cloudflare Pages, ...) win. |
| `true`      | Same, but the build fails when `nitro` is missing.                                       |
| object      | On with these options (`preset`, `output.{dir,publicDir,serverDir}`, `cloudflare.{nodeCompat,deployConfig}`, `compatibilityDate`, any other Nitro option); fails when `nitro` is missing. |
| `false`     | Off; TanStack Start writes its plain `dist/` output.                                     |

`SEEMODO_NITRO_PRESET` pins the preset over all of the above. `compatibilityDate` defaults to
`2025-09-01`. For Cloudflare targets the Worker name is pinned to the cleaned package name unless
the project has its own `wrangler.json(c)`/`wrangler.toml`.

Inside a Seemodo sandbox build the publish step needs a fixed layout, so the preset is
`SEEMODO_NITRO_PRESET` or `cloudflare-module` (a `nitro.preset`, `NITRO_PRESET` or `nitro.output` in
the app is ignored with a warning), the output is `.output/public` + `.output/server`, and Nitro is
required.

**Wrangler config fixer.** Cloudflare turns on Node.js compatibility by default for compatibility
dates from `2026-08-04`; the `nodejs_compat` / `nodejs_compat_v2` flags then have no effect. After
the build the generated `.output/server/wrangler.json` drops those flags when its
`compatibility_date` is on or after that date. Earlier dates are left alone.

No custom Worker entry is needed: Seemodo publishes Nitro's `cloudflare-module` output as is (the
deploy service wraps it with its own entry module).

## Prerendering

Enable it through TanStack Start, e.g. `tanstackStart: { prerender: { enabled: true } }` or per
page with `pages: [{ path: "/about", prerender: { enabled: true } }]`.

TanStack Start prerenders by starting `vite preview` and fetching each page. With Nitro's
Cloudflare preset that preview would spawn `wrangler dev`, so during the prerender pass
(`TSS_PRERENDERING=true`) this package leaves Nitro out and writes a small adapter to
`node_modules/.seemodo/prerender-server/` that serves pages from the built Worker
(`.output/server/index.mjs`, called with the `vars` from its wrangler.json). Prerendered pages are
written into `.output/public`.

Inside a Seemodo sandbox build:

- the output shape is pinned: `autoSubfolderIndex: true` (pages become `<route>/index.html`),
  `outputPath` is dropped, and `failOnError: false` so a route that fails to render falls back to
  SSR instead of failing the publish;
- a `[seemodo-prerender-report]` block lists how many routes were attempted and rendered and which
  failed (at most 50 routes, 200 characters each).

## Build reports

All reports are one JSON document between markers on stderr:

```
[seemodo-build-report]
{"version":1,"kind":"build-error","environment":"client","error":{"name":"Error","message":"...","plugin":"...","loc":{...},"frame":"...","stack":"..."}}
[/seemodo-build-report]
```

| Marker                      | When                                                   |
| --------------------------- | ------------------------------------------------------ |
| `seemodo-build-report`      | First build error (sandbox builds, `buildDiagnostics`) |
| `seemodo-prerender-report`  | After a sandbox build that prerendered                 |
| `seemodo-build-exit-report` | When the build exit watchdog ends the process          |

Each document stays below 6000 characters: error fields are clipped and nested errors limited with
progressively tighter budgets until it fits.

## Build exit watchdog

Server code evaluated during a build (prerendering, module-scope timers, connection pools, TanStack
Query `gcTime` timers armed during SSR) can keep Node alive after the output is written. Inside a
Seemodo sandbox build the watchdog arms an unref'd timer after the last build hook; if the process
is still running after the grace it prints a `[seemodo-build-exit-report]` with the open handle
types (`process.getActiveResourcesInfo()`) and exits with the current exit code.

- `buildExitWatchdog: { graceMs }`: default 60000, clamped to 5 s–10 min.
- `buildExitWatchdog: { enabled: false }` or `false`: off.
- `SEEMODO_BUILD_EXIT_GRACE_MS=<ms>` overrides the grace; `SEEMODO_BUILD_EXIT_WATCHDOG=off` turns it off.

## HMR gate

`@seemodo/vite-tanstack-config/hmr-gate`, on by default inside a sandbox (dev only).

The Seemodo agent writes change sets of many files, in several batches. Without the gate Vite
pushes an update per file and the preview runs half-written code. The gate sits between the file
watcher and Vite:

- **open** (default): watcher events pass through, normal HMR.
- **paused**: `change` / `add` / `unlink` events are queued per file; nothing reaches Vite. A file
  rewritten with the content it had at the last flush is dropped.
- **flush**: the queue is replayed in order and the gate opens. If an HTML page answered with a 5xx
  while paused, the flush ends with a full reload.

A pause always ends by itself: after the request's `timeoutMs` (1 s–`maxHoldMs`) or `maxHoldMs`
(default 120 s, max 10 min).

| Endpoint                      | Body                                              | Effect                     |
| ----------------------------- | ------------------------------------------------- | -------------------------- |
| `GET /__seemodo/hmr-gate`     |                                                   | status                     |
| `POST /__seemodo/hmr-gate`    | `{"action":"pause","reason":"...","timeoutMs":60000}` | pause (re-pausing extends) |
| `POST /__seemodo/hmr-gate`    | `{"action":"resume"}` / `{"action":"status"}`     | flush / status             |
| `POST /__seemodo/hmr-flush`   |                                                   | flush                      |

Responses include `state`, `pendingCount`, `pending` (first 200 paths), `autoResumeAt` and, for a
flush, `flushed` and `count`.

`SEEMODO_HMR_FULL_RELOAD=1` (or `hmrGate: { fullReload: true }`) answers every flush with one full
page reload instead of granular HMR updates: Vite's own updates right after the flush are folded
into a single reload.

Events sent to the browser over the Vite HMR channel (`import.meta.hot.on(...)`):

| Event                       | Data                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| `seemodo:dev-server-mode`   | `{ mode, hmr: "granular" \| "full-reload", gate, startedAt }` on connect |
| `seemodo:boot-progress`     | `{ ssrModules, clientModules, ssrIdleMs, clientIdleMs, buildError }`   |
| `seemodo:update-progress`   | `{ batch, trigger: "flush" \| "timeout" \| "watch", files, ssrModules, clientModules, idleMs, done, buildError }` |
| `seemodo:hmr-gate`          | gate status on every pause / flush                                     |

Progress events are throttled to two per second. Options: `fullReload`, `maxHoldMs`, `startPaused`,
`events`, `passthrough`, `token`. With Vite's `experimental.bundledDev` the gate stays inactive.

## Dev server bridge

`@seemodo/vite-tanstack-config/dev-server-bridge`, on by default inside a sandbox (dev only).

| Endpoint                            | Access  | Purpose                                                                 |
| ----------------------------------- | ------- | ----------------------------------------------------------------------- |
| `POST /__seemodo/error-collector`   | page    | Browser error report (JSON object, ≤ 16 KiB, ≤ 120/min)                 |
| `POST /__seemodo/restart-announce`  | control | `{"reason"?}` → `seemodo:dev-server-restarting` to every preview tab    |
| `POST /__seemodo/preview-execute`   | control | `{"code","timeoutMs"?}` → runs in every preview tab, returns results    |
| `GET /__seemodo/viewers`            | control | Connected preview tabs (`count`, `viewers[]` with URL and title)        |

**Error collector.** A small client module (loaded with Vite's HMR client) reports uncaught errors,
unhandled rejections and failed `<script>`/`<img>`/`<link>` loads. Each report is written as a
`[seemodo:error] {"source":"browser",...}` line to stderr and appended to
`.seemodo/dev-errors.jsonl` (emptied on start, capped at 2 MiB, ignored by the watcher). Options:
`endpoint`, `outputFile` (`false` for no file), `maxBodyBytes`, `resetOnStart`, `maxReportsPerMinute`.
Oversized bodies get 413, invalid ones 400, bursts 429.

**Preview execute.** `code` is the body of an async function (`return document.title`), at most
32 KiB; `timeoutMs` defaults to 3000 (100–15000). The response is
`{ id, viewers, responded, timedOut, results: [{ viewerId, url, ok, durationMs, result | error }] }`
where `result` is `{ kind: "json", value }`, `{ kind: "undefined" }` or `{ kind: "truncated" }`
(values over 16 KiB). DOM elements are returned as their `outerHTML`. Only enabled inside a sandbox
(`previewExecute: true` enables it elsewhere); at most four requests run at once.

**Server errors.** Server-side `[seemodo:error]` reports (SSR, 5xx, server functions, Vite) are
also sent to preview tabs as `seemodo:server-error`.

**Access.** "control" endpoints (and the HMR gate endpoints) accept direct loopback requests only:
no `X-Forwarded-*`/`Forwarded` headers (so nothing that came through the sandbox's public preview
proxy), no `Origin` or `Sec-Fetch-*` headers (so no browser page). Set `SEEMODO_DEV_BRIDGE_TOKEN`
to allow other callers that send `Authorization: Bearer <token>` or `x-seemodo-token: <token>`;
with a token set, only the token counts.

## How it maps to Seemodo

| Piece                         | Seemodo counterpart                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Sandbox detection             | `SEEMODO_SANDBOX=1` or `SANDBOX_APP_DIR` (set by the Modal / Boat sandbox images).                    |
| `[seemodo:error]` lines       | The sandbox control server (`backend/sandbox-control/server.js`) keeps Vite's stderr; the backend reads it through `GET /errors/vite`, so the agent sees server *and* browser errors there. |
| Error collector               | Complements `/seemodo.js`: that bridge already posts `RUNTIME_ERROR` / `CONSOLE_LOG` to the editor via `postMessage`; the collector gets the same browser errors to the agent through the dev server log (the editor's copy is not duplicated). |
| Editor events                 | The client module forwards to the editor with the `/seemodo.js` envelope `{ type, payload, source: "seemodo-bridge" }`: `DEV_SERVER_RESTARTING`, `SERVER_ERROR`, `DEV_SERVER_STATUS` (`{ event, data }` for mode, gate and progress events). The editor's `sandbox-bridge.ts` ignores types it does not handle yet. |
| Restart announce              | The control server restarts Vite on `POST /vite/restart` and `POST /npm-install`; calling `POST http://127.0.0.1:5173/__seemodo/restart-announce` just before lets the editor show "restarting" instead of an error. |
| HMR gate                      | Meant for the control server / backend around multi-file syncs (`POST /files/write`, chunked by `SyncFilesToSandbox`): pause before the first chunk, flush after the last. |
| Preview execute / viewers     | A real channel into the preview tab for the agent's browser tool (`POST /__control/browser` currently answers with simulated results). |
| Build reports / watchdog      | `POST /build/production` runs `vite build`; the markers make the cause of a failed or hanging publish build machine-readable. |
| Output layout                 | `assembleTanStackDist` copies `.output/public` and `.output/server` into the publish bundle; sandbox builds pin exactly that layout. |
| Asset proxy                   | Seemodo has no platform asset CDN path today; the proxy is generic and off unless configured.         |

## Asset proxy

Dev only and off unless both variables are set:

- `SEEMODO_PREVIEW_HOST`: host (optionally `:port`) of an HTTPS origin, no scheme, e.g. `preview.example.com`
- `SEEMODO_ASSETS_PATH`: path prefix to forward, e.g. `/__seemodo/assets/`

Requests under the prefix are forwarded to `https://<host><same path>` (cookies and hop-by-hop
headers stripped, 30 s timeout, 502 on failure), so assets that only exist on that origin also load
when the app is opened straight from the dev server.

## Deploy

```sh
vite build
npx wrangler deploy --config .output/server/wrangler.json
```

## Environment variables

| Variable                       | Effect                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `SEEMODO_SANDBOX`              | `1` marks a Seemodo sandbox (also: `SANDBOX_APP_DIR` set) |
| `SEEMODO_NITRO_PRESET`         | Pins the Nitro preset                                     |
| `SEEMODO_HMR_FULL_RELOAD`      | `1`: full reload after each HMR gate flush                |
| `SEEMODO_DEV_BRIDGE_TOKEN`     | Token for control endpoints                               |
| `SEEMODO_BUILD_EXIT_GRACE_MS`  | Build exit watchdog grace (ms)                            |
| `SEEMODO_BUILD_EXIT_WATCHDOG`  | `off` disables the watchdog                               |
| `SEEMODO_PREVIEW_HOST`         | Asset proxy upstream host                                 |
| `SEEMODO_ASSETS_PATH`          | Asset proxy path prefix                                   |
| `PORT`                         | Dev server port (default 5173)                            |

## License

MIT © Seemodo
