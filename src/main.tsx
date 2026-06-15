import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installGlobalLogHandlers, log } from "./lib/logger";
import "./index.css";

installGlobalLogHandlers();
log.info("main.tsx: mounting React root");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
