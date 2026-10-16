# Seemodo TanStack Start starter

Full-stack React app: TanStack Start (SSR, server functions), TanStack Router, React 19,
TypeScript, Tailwind CSS 4, shadcn/ui, Vite 8. Builds to Cloudflare Workers.

## Structure

- Pages live in `src/routes/` (file-based routing). `src/routes/__root.tsx` is the HTML
  shell for every page; keep its `<Outlet />`, `<HeadContent />` and `<Scripts />`.
- `src/routeTree.gen.ts` is generated from `src/routes/`. Never edit it by hand.
- There is no `index.html`, `main.tsx` or `App.tsx`. Do not create them.
- Server logic uses server functions: `createServerFn` from `@tanstack/react-start`,
  called from components or route loaders. Put secrets and server-only code in
  `*.server.ts` files; never import them from client code.
- `src/server.ts` (server entry), `src/start.ts` (request middleware: error page, CSRF for
  server functions) and `src/router.tsx` (router setup) are infrastructure; change them
  only when needed.
- UI components: `src/components/ui/` (shadcn/ui). Theme tokens: `src/styles.css`.
- Import from `src` with the `@/` alias, e.g. `import { cn } from "@/lib/utils"`.

## Config and commands

- `vite.config.ts` is one `defineConfig()` call from `@seemodo/vite-tanstack-config`
  (installed from npm, source in `packages/vite-tanstack-config`). It already adds TanStack Start, React, Tailwind,
  tsconfig paths, Nitro and the dev server settings. Do not add those plugins again; use
  `defineConfig({ vite: { ... } })` or `plugins: [...]` for extras.
- Dev server errors (server and browser) are logged as `[seemodo:error] {json}` lines; browser
  errors are also collected in `.seemodo/dev-errors.jsonl`. Paths under `/__seemodo/` belong to
  the dev server; do not create routes there.
- `bun run dev` (port 5173), `bun run build` (output in `.output/`: `public/` static
  assets, `server/index.mjs` Worker, `server/wrangler.json`), `bun run typecheck`,
  `bun run lint`, `bun run test`.

<!-- SEEMODO:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Seemodo](https://seemodo.com). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Seemodo's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Seemodo and show up in
> the editor, so keep the branch in a working state.

<!-- SEEMODO:END -->
