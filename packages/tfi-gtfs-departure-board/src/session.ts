import {
  type DepartureService,
  StopNotFoundError,
} from "@tfi-gtfs/tfi-gtfs-core";
import z from "zod";
import {
  type ServerMessage,
  type Subscription,
  subscribeMessageSchema,
} from "./protocol";
import type { RouteStopPair } from "./route-stop-pairs";
import { type PairDepartures, selectTrips } from "./trips";

/** The parts of a WebSocket a session uses */
export type DepartureBoardSocket = {
  send(data: string): void;
  close(code: number, reason: string): void;
};

/** Pino-style, as Fastify's request logger */
export type DepartureBoardLogger = {
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
};

export type DepartureBoardOptions = {
  /** The firmware reconnects after 60 s without a heartbeat */
  heartbeatIntervalMs: number;
  scheduleIntervalMs: number;
};

const DEFAULT_OPTIONS: DepartureBoardOptions = {
  heartbeatIntervalMs: 30_000,
  scheduleIntervalMs: 30_000,
};

// Departures read per pair, enough to fill a board after the route filter
// and `nextPerRoute`
const DEPARTURES_PER_PAIR = 50;

// RFC 6455 policy violation, for a message we can't act on
const INVALID_MESSAGE = 1008;
// Close reasons are limited to 123 bytes of UTF-8
const MAX_REASON_BYTES = 123;

/**
 * One Departure Board's connection: heartbeats from the start, then a
 * schedule straight after each `schedule:subscribe` and at every interval
 * after. A new subscribe replaces the last.
 */
export class DepartureBoardSession {
  private readonly options: DepartureBoardOptions;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private scheduleTimer: ReturnType<typeof setInterval> | undefined;
  private subscription: Subscription | undefined;
  /** Pairs already warned about for the current subscription */
  private warned = new Set<RouteStopPair>();
  /** The subscription whose push is being read, if any */
  private pushing: Subscription | undefined;
  private closed = false;

  constructor(
    private readonly socket: DepartureBoardSocket,
    private readonly departureService: DepartureService,
    private readonly logger: DepartureBoardLogger,
    options: Partial<DepartureBoardOptions> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.socket = socket;
    this.departureService = departureService;
    this.logger = logger;
    this.now = now;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.heartbeat = setInterval(
      () => this.send({ event: "heartbeat", data: null }),
      this.options.heartbeatIntervalMs,
    );
  }

  receive(raw: string): void {
    if (this.closed) return;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.reject("Message is not JSON");
      return;
    }
    const message = subscribeMessageSchema.safeParse(json);
    if (!message.success) {
      this.reject(z.prettifyError(message.error));
      return;
    }

    this.subscription = message.data.data;
    this.warned = new Set();
    clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(
      () => void this.push(),
      this.options.scheduleIntervalMs,
    );
    void this.push();
  }

  /** Stops the timers; call when the socket closes */
  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearInterval(this.scheduleTimer);
  }

  private async push(): Promise<void> {
    const subscription = this.subscription;
    // A slow read still running when the next interval comes is left to finish
    if (!subscription || this.pushing === subscription) return;
    this.pushing = subscription;
    try {
      const results = await Promise.all(
        subscription.routeStopPairs.map((pair) => this.read(pair)),
      );
      // Replaced or closed while reading
      if (this.closed || subscription !== this.subscription) return;
      this.send({
        event: "schedule",
        data: { trips: selectTrips(results, subscription) },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to read Departures for board");
    } finally {
      if (this.pushing === subscription) this.pushing = undefined;
    }
  }

  private async read(pair: RouteStopPair): Promise<PairDepartures> {
    try {
      const departures = await this.departureService.getDepartures({
        stopId: pair.stopId,
        from: new Date(this.now().getTime() + pair.walkTimeSeconds * 1000),
        directionId: pair.directionId,
        limit: DEPARTURES_PER_PAIR,
      });
      if (departures.length === 0) {
        this.warnOnce(
          pair,
          "No Departures for board pair; is it a Watched Stop?",
        );
      }
      return { pair, departures };
    } catch (error) {
      if (!(error instanceof StopNotFoundError)) throw error;
      this.warnOnce(pair, "Unknown Stop in board pair; is it a Watched Stop?");
      return { pair, departures: [] };
    }
  }

  private warnOnce(pair: RouteStopPair, message: string): void {
    if (this.warned.has(pair)) return;
    this.warned.add(pair);
    this.logger.warn({ pair }, message);
  }

  private reject(reason: string): void {
    this.logger.warn({ reason }, "Closing board socket on invalid message");
    this.send({ event: "error", data: { message: reason } });
    this.close();
    this.socket.close(INVALID_MESSAGE, truncate(reason, MAX_REASON_BYTES));
  }

  private send(message: ServerMessage): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }
}

function truncate(value: string, bytes: number): string {
  let truncated = value;
  while (Buffer.byteLength(truncated) > bytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}
