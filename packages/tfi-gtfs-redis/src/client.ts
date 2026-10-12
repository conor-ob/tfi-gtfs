import { createClient, type RedisClientType } from "redis";

// Trip Updates are optional, so a slow or missing Redis must fail a request's
// lookup quickly rather than hold up its Departures
const COMMAND_TIMEOUT_MS = 500;

/**
 * Connects in the background and keeps reconnecting. Until connected,
 * commands fail at once instead of queueing.
 */
export function createRedisClient(
  url: string,
  onError: (error: unknown) => void,
): RedisClientType {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
    socket: { connectTimeout: 5_000 },
  }) as RedisClientType;
  // Without a listener, a connection error would crash the process
  client.on("error", onError);
  client.connect().catch(onError);
  return client;
}
