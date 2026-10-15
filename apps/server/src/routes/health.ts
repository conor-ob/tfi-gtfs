import type { FastifyInstance } from "fastify";

import { env } from "~/env/schema";

// Healthy only once a Schedule is open, so a deploy never serves without one
// (see docs/adr/0011)
export default function (fastify: FastifyInstance) {
  fastify.get("/health", (_req, res) => {
    const { isOpen, feedVersion } = fastify.scheduleLoader;
    res.status(isOpen ? 200 : 503).send({
      env: env.NODE_ENV,
      message: isOpen ? "OK" : "No Schedule is open",
      feedVersion,
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });
}
