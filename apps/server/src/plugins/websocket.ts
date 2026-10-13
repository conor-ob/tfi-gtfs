import FastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

export default function (fastify: FastifyInstance) {
  fastify.register(FastifyWebsocket);
}
