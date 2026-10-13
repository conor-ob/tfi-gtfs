import { QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "@tfi-gtfs/tfi-gtfs-trpc";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";

export type Departure =
  inferRouterOutputs<AppRouter>["departures"]["getByStop"][number];

export const queryClient = new QueryClient();

const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      // Proxied to the server by Caddy in production and vite in development
      url: "/api/trpc",
      transformer: superjson,
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient,
});
