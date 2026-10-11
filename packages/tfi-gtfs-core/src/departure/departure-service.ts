import type { Departure, DepartureQuery } from "./domain/types";
import type { DepartureService } from "./interfaces/inbound/departure-service";
import type { DepartureRepository } from "./interfaces/outbound/departure-repository";
import { addDays, localDateOf, serviceDayStart } from "./service-day";

// How far ahead to look, so a quiet Stop doesn't scan the whole Schedule
const HORIZON_MS = 24 * 60 * 60 * 1000;

export class StopNotFoundError extends Error {
  constructor(stopId: string) {
    super(`No Stop with id '${stopId}'`);
    this.name = "StopNotFoundError";
  }
}

export class DepartureServiceImpl implements DepartureService {
  constructor(
    private readonly departureRepository: DepartureRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.departureRepository = departureRepository;
    this.now = now;
  }

  async getDepartures({
    stopId,
    from = this.now(),
    limit,
  }: DepartureQuery): Promise<Departure[]> {
    const stop = await this.departureRepository.findStop(stopId);
    if (!stop) throw new StopNotFoundError(stopId);

    const until = from.getTime() + HORIZON_MS;
    // Yesterday's Trips can still be running after midnight (Stop Times past
    // 24:00:00), and tomorrow's can start within the horizon
    const today = localDateOf(from);
    const serviceDates = [addDays(today, -1), today, addDays(today, 1)];

    const departures = await Promise.all(
      serviceDates.map(async (serviceDate) => {
        const start = serviceDayStart(serviceDate).getTime();
        const toTime = Math.floor((until - start) / 1000);
        if (toTime < 0) return [];
        const stopTimes = await this.departureRepository.findScheduledStopTimes(
          {
            stopId,
            serviceDate,
            fromTime: Math.max(0, Math.ceil((from.getTime() - start) / 1000)),
            toTime,
            limit,
          },
        );
        return stopTimes.map(
          ({ departureTime, ...stopTime }): Departure => ({
            ...stopTime,
            serviceDate,
            scheduledDeparture: new Date(start + departureTime * 1000),
          }),
        );
      }),
    );

    return departures
      .flat()
      .sort(
        (a, b) =>
          a.scheduledDeparture.getTime() - b.scheduledDeparture.getTime() ||
          a.tripId.localeCompare(b.tripId),
      )
      .slice(0, limit);
  }
}
