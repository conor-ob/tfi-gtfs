import { BoardPage } from "./board-page";
import { DeparturesPage } from "./departures-page";
import { StopsPage } from "./stops-page";

/** `/departures` merges every Stop's Departures, `/board` draws them like the
 * Departure Board; anything else is `/stops` */
export function App() {
  switch (window.location.pathname) {
    case "/departures":
      return <DeparturesPage />;
    case "/board":
      return <BoardPage />;
    default:
      return <StopsPage />;
  }
}
