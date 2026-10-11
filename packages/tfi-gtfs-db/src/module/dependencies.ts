import { createDatabaseConnection } from "../db/connection";

export function injectDependencies() {
  const _database = createDatabaseConnection();
  return {};
}
