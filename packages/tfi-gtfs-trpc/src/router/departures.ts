import { StopNotFoundError } from "@tfi-gtfs/tfi-gtfs-core";
import { TRPCError } from "@trpc/server";
import z from "zod";
import { publicProcedure, router } from "../trpc/router";

export const departuresRouter = router({
  getByStop: publicProcedure
    .input(
      z.object({
        stopId: z.string().min(1),
        /** Earliest Scheduled Departure to include; defaults to now */
        from: z.date().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await ctx.departureService.getDepartures(input);
      } catch (error) {
        if (error instanceof StopNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
            cause: error,
          });
        }
        throw error;
      }
    }),
});
