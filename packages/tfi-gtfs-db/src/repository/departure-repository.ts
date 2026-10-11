import type {
  DepartureRepository,
  ScheduledStopTime,
  Stop,
} from "@tfi-gtfs/tfi-gtfs-core";
import {
  and,
  asc,
  between,
  eq,
  exists,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  calendarDatesTable,
  calendarTable,
  routesTable,
  stopsTable,
  stopTimesTable,
  tripsTable,
} from "../db/schema";

// Indexed by Date.getUTCDay()
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const ADDED = 1;
const REMOVED = 2;
const NO_PICKUP = 1;

export class DepartureRepositoryImpl implements DepartureRepository {
  constructor(private readonly database: NodePgDatabase) {
    this.database = database;
  }

  async findStop(stopId: string): Promise<Stop | null> {
    const [stop] = await this.database
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.stopId, stopId))
      .limit(1);
    return stop ?? null;
  }

  async findScheduledStopTimes({
    stopId,
    serviceDate,
    fromTime,
    toTime,
    limit,
  }: {
    stopId: string;
    serviceDate: string;
    fromTime: number;
    toTime: number;
    limit: number;
  }): Promise<ScheduledStopTime[]> {
    return this.database
      .select({
        tripId: stopTimesTable.tripId,
        stopId: stopTimesTable.stopId,
        stopSequence: stopTimesTable.stopSequence,
        // never null within the `between` below
        departureTime: sql<number>`${stopTimesTable.departureTime}`,
        headsign: sql<
          string | null
        >`coalesce(${stopTimesTable.stopHeadsign}, ${tripsTable.tripHeadsign})`,
        directionId: tripsTable.directionId,
        routeId: routesTable.routeId,
        routeShortName: routesTable.routeShortName,
        routeLongName: routesTable.routeLongName,
        routeType: routesTable.routeType,
        agencyId: routesTable.agencyId,
      })
      .from(stopTimesTable)
      .innerJoin(tripsTable, eq(tripsTable.tripId, stopTimesTable.tripId))
      .innerJoin(routesTable, eq(routesTable.routeId, tripsTable.routeId))
      .where(
        and(
          eq(stopTimesTable.stopId, stopId),
          between(stopTimesTable.departureTime, fromTime, toTime),
          or(
            isNull(stopTimesTable.pickupType),
            ne(stopTimesTable.pickupType, NO_PICKUP),
          ),
          this.runsOn(serviceDate),
        ),
      )
      .orderBy(asc(stopTimesTable.departureTime), asc(stopTimesTable.tripId))
      .limit(limit);
  }

  /**
   * Whether the Trip's Service Calendar includes the date: a regular weekday
   * in range that wasn't removed, or an added date
   */
  private runsOn(serviceDate: string) {
    const weekday = WEEKDAYS[new Date(serviceDate).getUTCDay()] ?? "sunday";
    const exception = (exceptionType: number) =>
      this.database
        .select({ one: sql`1` })
        .from(calendarDatesTable)
        .where(
          and(
            eq(calendarDatesTable.serviceId, tripsTable.serviceId),
            eq(calendarDatesTable.date, serviceDate),
            eq(calendarDatesTable.exceptionType, exceptionType),
          ),
        );
    const regular = this.database
      .select({ one: sql`1` })
      .from(calendarTable)
      .where(
        and(
          eq(calendarTable.serviceId, tripsTable.serviceId),
          eq(calendarTable[weekday], true),
          sql`${serviceDate}::date between ${calendarTable.startDate} and ${calendarTable.endDate}`,
        ),
      );
    return or(
      and(exists(regular), notExists(exception(REMOVED))),
      exists(exception(ADDED)),
    );
  }
}
