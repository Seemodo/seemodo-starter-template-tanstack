# Seemodo TanStack Start starter

The starter template for full-stack [Seemodo](https://seemodo.com) projects: TanStack Start
(React 19, SSR, server functions), Vite 8, Tailwind CSS 4 and shadcn/ui, built for
Cloudflare Workers.

Open your project in the [Seemodo editor](https://seemodo.com) and keep building, or work
locally. Commits pushed to the connected GitHub branch sync back into Seemodo.

## Development

Requires Node.js 20.19+ and [Bun](https://bun.sh) (npm works too).

```sh
git clone <this-repository-url>
cd <repository-name>
bun install
bun run dev        # http://localhost:5173
```

| Command             | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `bun run dev`       | Vite dev server with SSR and HMR                            |
| `bun run build`     | Production build (Cloudflare Workers) into `.output/`       |
| `bun run preview`   | Serve the production build with `wrangler dev` on port 4173 |
| `bun run typecheck` | `tsc --noEmit`                                              |
| `bun run lint`      | ESLint                                                      |
| `bun run test`      | Vitest                                                      |

## Project layout

- `src/routes/` holds the pages. Routing is file-based: `index.tsx` is `/`, `about.tsx` is
  `/about`, `posts/$id.tsx` is `/posts/:id`. `src/routes/__root.tsx` is the HTML shell
  (head, body, providers) around every page.
- `src/routeTree.gen.ts` is generated from `src/routes/` by the dev server and the build.
  Do not edit it by hand.
- There is no `index.html`, `main.tsx` or `App.tsx`: TanStack Start renders the document
  on the server from `__root.tsx`.
- Server code runs through server functions (`createServerFn` from
  `@tanstack/react-start`) called directly from components and loaders. Keep secrets and
  server-only modules in `*.server.ts` files.
- `src/server.ts` is the server entry (wraps SSR with an error page), `src/start.ts`
  registers request middleware (error handling, CSRF protection for server functions),
  `src/router.tsx` creates the router.
- `src/components/ui/` contains the shadcn/ui components, `src/styles.css` the Tailwind
  theme.

## Build output

`vite build` writes a Cloudflare Workers bundle (Nitro preset `cloudflare-module`):

```
.output/
  public/            static assets served by Workers Assets (assets/*, favicon.ico, ...)
  public/_headers    long-term caching for /assets/*
  server/index.mjs   the Worker (ES module)
  server/wrangler.json
  nitro.json
```

Deploy with `npx wrangler deploy --config .output/server/wrangler.json`. Set
`SEEMODO_NITRO_PRESET` (for example `node-server`, `vercel`, `netlify`) to target another
platform.

## Vite config

`vite.config.ts` is a single `defineConfig()` call from `@seemodo/vite-tanstack-config`
(installed from npm; source in `packages/vite-tanstack-config`). It adds
TanStack Start, React, Tailwind, tsconfig paths, the `@/` alias, React/TanStack dedupe, the dev
server settings, error logging and Nitro for builds. Extra Vite settings go into
`defineConfig({ vite: { ... } })`.

Inside a Seemodo sandbox it also turns on the HMR gate (`/__seemodo/hmr-gate`), the browser error
collector (`.seemodo/dev-errors.jsonl`), preview execution and machine-readable build reports. See
[packages/vite-tanstack-config/README.md](packages/vite-tanstack-config/README.md) for all options,
endpoints and environment variables.

## Built with

- TanStack Start and TanStack Router
- React 19 and TypeScript
- Tailwind CSS 4 and shadcn/ui
- Vite 8 and Nitro
