import z from "zod";
import { publicProcedure, router } from "../trpc/router";

export const stopsRouter = router({
  getNearby: publicProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        /** In metres */
        radius: z.number().min(1).max(2000).default(500),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(({ ctx, input }) => ctx.stopService.getNearbyStops(input)),
});
