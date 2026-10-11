import { departuresRouter } from "../router/departures";
import { stopsRouter } from "../router/stops";
import { createCallerFactory, router } from "./router";

export const appRouter = router({
  departures: departuresRouter,
  stops: stopsRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
