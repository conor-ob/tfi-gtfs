import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@tfi-gtfs/tfi-gtfs-web-shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BoardPage } from "./board-page";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container missing in the DOM");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BoardPage />
    </QueryClientProvider>
  </StrictMode>,
);
