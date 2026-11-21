import React from "react";
import ReactDOM from "react-dom/client";
import { guestLinkFor, inTauri } from "./guest/route";
import { installCanvasFilterPolyfill } from "./lib/canvasFilterPolyfill";
import { installGlobalLogHandlers, log } from "./lib/logger";
import "./index.css";

installGlobalLogHandlers();
if (installCanvasFilterPolyfill()) {
  log.info("main.tsx: installed canvas filter polyfill (no native ctx.filter)");
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const guestLink = guestLinkFor(window.location.href, inTauri());

// Dynamic imports keep guest mode from ever evaluating the desktop app's Tauri modules.
if (guestLink) {
  log.info(`main.tsx: mounting guest mode for room ${guestLink.roomId}`);
  void import("./guest/GuestApp").then(({ GuestApp }) =>
    root.render(
      <React.StrictMode>
        <GuestApp link={guestLink} />
      </React.StrictMode>,
    ),
  );
} else {
  log.info("main.tsx: mounting React root");
  void import("./App").then(({ App }) =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
}
