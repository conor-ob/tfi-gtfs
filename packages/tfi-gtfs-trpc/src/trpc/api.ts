import { departuresRouter } from "../router/departures";
import { createCallerFactory, router } from "./router";

export const appRouter = router({
  departures: departuresRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
