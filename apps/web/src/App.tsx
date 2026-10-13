import { DeparturesPage } from "./departures-page";
import { StopsPage } from "./stops-page";

/** `/departures` merges every Stop's Departures; anything else is `/stops` */
export function App() {
  return window.location.pathname === "/departures" ? (
    <DeparturesPage />
  ) : (
    <StopsPage />
  );
}
