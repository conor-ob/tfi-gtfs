import { BoardPage } from "./board-page";
import { DeparturesPage } from "./departures-page";
import { StopsPage } from "./stops-page";

/** `/stops` and `/departures` are lists; anything else is the board */
export function App() {
  switch (window.location.pathname) {
    case "/stops":
      return <StopsPage />;
    case "/departures":
      return <DeparturesPage />;
    default:
      return <BoardPage />;
  }
}
