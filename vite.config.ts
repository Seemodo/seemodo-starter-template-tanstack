// Vite config for this TanStack Start app.
//
// `defineConfig` from @seemodo/vite-tanstack-config (npm; source in packages/vite-tanstack-config)
// already wires TanStack Start, React, Tailwind, tsconfig paths, the `@` alias,
// React/TanStack dedupe, the dev server (port 5173, sandbox HMR), error logging
// and Nitro for `vite build` (Cloudflare Workers by default). Do not add those
// plugins again; pass extra settings via `plugins` or `vite: { ... }`.
import { defineConfig } from "@seemodo/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Use src/server.ts (SSR error wrapper) as the server entry.
    server: { entry: "server" },
  },
});
