import type { DepartureService, StopService } from "@tfi-gtfs/tfi-gtfs-core";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import z, { ZodError } from "zod";

// Core services are passed in by the server's composition root
export function createTrpcContext({
  departureService,
  stopService,
}: {
  departureService: DepartureService;
  stopService: StopService;
}) {
  return { departureService, stopService };
}

const t = initTRPC
  .context<Awaited<ReturnType<typeof createTrpcContext>>>()
  .create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
      return {
        ...shape,
        data: {
          ...shape.data,
          zodError:
            error.code === "BAD_REQUEST" && error.cause instanceof ZodError
              ? z.treeifyError(error.cause)
              : null,
        },
      };
    },
  });

export const createCallerFactory = t.createCallerFactory;

export const router = t.router;

export const publicProcedure = t.procedure;
