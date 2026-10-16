import { QueryClient } from "@tanstack/react-query";
import { createRouter, ErrorComponent, type ErrorComponentProps } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// TanStack's default error component only renders loader/route errors. Log them too, so they
// reach the dev server output (and the Seemodo editor) with their message and stack.
function DefaultRouteError(props: ErrorComponentProps) {
  console.error(props.error);
  return <ErrorComponent {...props} />;
}

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultRouteError,
  });

  return router;
};
