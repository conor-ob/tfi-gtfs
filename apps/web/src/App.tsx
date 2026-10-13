import { DeparturesPage } from "./departures-page";
import { StopsPage } from "./stops-page";

/** `/stops` has a section per Stop; anything else is the merged list */
export function App() {
  switch (window.location.pathname) {
    case "/stops":
      return <StopsPage />;
    default:
      return <DeparturesPage />;
  }
}
