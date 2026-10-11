import { Client } from "pg";
import { createDatabaseConnection } from "../db/connection";
import { env } from "../env/schema";
import { DepartureRepositoryImpl } from "../repository/departure-repository";
import { ScheduleImportRepositoryImpl } from "../repository/schedule-import-repository";
import { StopRepositoryImpl } from "../repository/stop-repository";

export function injectDependencies() {
  const database = createDatabaseConnection();
  return {
    departureRepository: new DepartureRepositoryImpl(database),
    stopRepository: new StopRepositoryImpl(database),
    scheduleImportRepository: new ScheduleImportRepositoryImpl(
      database,
      async () => {
        const client = new Client({
          connectionString: env.DATABASE_URL,
          application_name: "tfi-gtfs-schedule-import",
        });
        await client.connect();
        return client;
      },
    ),
    /** Lets short-lived processes such as jobs exit */
    close: () => database.$client.end(),
  };
}
