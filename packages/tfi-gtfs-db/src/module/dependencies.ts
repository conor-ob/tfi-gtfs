import { createDatabaseConnection } from "../db/connection";
import { DepartureRepositoryImpl } from "../repository/departure-repository";
import { StopRepositoryImpl } from "../repository/stop-repository";

export function injectDependencies() {
  const database = createDatabaseConnection();
  return {
    database,
    departureRepository: new DepartureRepositoryImpl(database),
    stopRepository: new StopRepositoryImpl(database),
    /** Lets short-lived processes such as jobs exit */
    close: () => database.$client.end(),
  };
}
