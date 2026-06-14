import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { NotFound } from "./components/NotFound";
import "./globals.css";

// Every search param in this app is a string (routes validate with
// z.coerce.string() / string enums), so plain query-string codec it is.
// The default JSON codec quotes numeric-looking strings (?id=%226%22).
const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFound,
  parseSearch: (searchStr) =>
    Object.fromEntries(new URLSearchParams(searchStr)),
  stringifySearch: (search) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
    const str = params.toString();
    return str ? `?${str}` : "";
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
