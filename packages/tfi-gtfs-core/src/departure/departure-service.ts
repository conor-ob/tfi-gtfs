import { tripUpdateKey } from "../realtime/domain/types";
import type { RealtimeService } from "../realtime/interfaces/inbound/realtime-service";
import type { Departure, DepartureQuery } from "./domain/types";
import type { DepartureService } from "./interfaces/inbound/departure-service";
import type { DepartureRepository } from "./interfaces/outbound/departure-repository";
import { predictDeparture } from "./predict";
import { addDays, localDateOf, serviceDayStart } from "./service-day";

// How far ahead to look, so a quiet Stop doesn't scan the whole Schedule
const HORIZON_MS = 24 * 60 * 60 * 1000;
// A late Trip is still to come after its Scheduled Departure has passed
const LOOKBACK_MS = 60 * 60 * 1000;
const LOOKBACK_LIMIT = 100;
// Cancelled Trips and skipped Stops drop out, so read a few spare
const SPARE = 10;

export class StopNotFoundError extends Error {
  constructor(stopId: string) {
    super(`No Stop with id '${stopId}'`);
    this.name = "StopNotFoundError";
  }
}

export class DepartureServiceImpl implements DepartureService {
  constructor(
    private readonly departureRepository: DepartureRepository,
    private readonly realtimeService: RealtimeService,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.departureRepository = departureRepository;
    this.realtimeService = realtimeService;
    this.now = now;
  }

  async getDepartures({
    stopId,
    from = this.now(),
    directionId,
    limit,
  }: DepartureQuery): Promise<Departure[]> {
    const stop = await this.departureRepository.findStop(stopId);
    if (!stop) throw new StopNotFoundError(stopId);

    const snapshot = await this.realtimeService.getTripUpdates();
    const at = from.getTime();
    const [recent, upcoming] = await Promise.all([
      snapshot
        ? this.scheduledBetween(
            stopId,
            directionId,
            at - LOOKBACK_MS,
            at - 1,
            LOOKBACK_LIMIT,
          )
        : [],
      this.scheduledBetween(
        stopId,
        directionId,
        at,
        at + HORIZON_MS,
        snapshot ? limit + SPARE : limit,
      ),
    ]);

    return [...recent, ...upcoming]
      .flatMap((departure) => {
        const predicted = snapshot
          ? predictDeparture(
              departure,
              snapshot.tripUpdates.get(
                tripUpdateKey(departure.tripId, departure.serviceDate),
              ),
            )
          : departure;
        return predicted && departsAt(predicted) >= at ? [predicted] : [];
      })
      .sort(
        (a, b) =>
          departsAt(a) - departsAt(b) || a.tripId.localeCompare(b.tripId),
      )
      .slice(0, limit);
  }

  /** Scheduled Departures between two instants (inclusive), earliest first */
  private async scheduledBetween(
    stopId: string,
    directionId: number | undefined,
    from: number,
    until: number,
    limit: number,
  ): Promise<Departure[]> {
    // Yesterday's Trips can still be running after midnight (Stop Times past
    // 24:00:00)
    const serviceDates = [addDays(localDateOf(new Date(from)), -1)];
    const lastDate = localDateOf(new Date(until));
    while (serviceDates.at(-1) !== lastDate) {
      serviceDates.push(addDays(serviceDates.at(-1) as string, 1));
    }

    const departures = await Promise.all(
      serviceDates.map(async (serviceDate) => {
        const start = serviceDayStart(serviceDate).getTime();
        const toTime = Math.floor((until - start) / 1000);
        if (toTime < 0) return [];
        const stopTimes = await this.departureRepository.findScheduledStopTimes(
          {
            stopId,
            serviceDate,
            directionId,
            fromTime: Math.max(0, Math.ceil((from - start) / 1000)),
            toTime,
            limit,
          },
        );
        return stopTimes.map(
          ({ departureTime, ...stopTime }): Departure => ({
            ...stopTime,
            serviceDate,
            scheduledDeparture: new Date(start + departureTime * 1000),
            predictedDeparture: null,
          }),
        );
      }),
    );
    return departures.flat();
  }
}

function departsAt(departure: Departure): number {
  return (
    departure.predictedDeparture ?? departure.scheduledDeparture
  ).getTime();
}
