import { StopNotFoundError } from "@tfi-gtfs/tfi-gtfs-core";
import { TRPCError } from "@trpc/server";
import z from "zod";
import { publicProcedure, router } from "../trpc/router";

export const departuresRouter = router({
  getByStop: publicProcedure
    .input(
      z.object({
        stopId: z.string().min(1),
        /** Earliest Departure to include (Predicted, else Scheduled); defaults to now */
        from: z.date().optional(),
        /** Only Trips in this direction (GTFS `direction_id`); defaults to both */
        directionId: z.union([z.literal(0), z.literal(1)]).optional(),
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
