import { createCallerFactory, router } from "./router";

export const appRouter = router({});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
