import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bitte warten" },
      { name: "description", content: "Bitte warten – die Seite wird vorbereitet." },
      { property: "og:title", content: "Bitte warten" },
      { property: "og:description", content: "Bitte warten – die Seite wird vorbereitet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-foreground" />
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">Bitte warten</h1>
    </main>
  );
}
