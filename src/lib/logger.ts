/**
 * Centralized logger.
 *
 * In a Tauri context every call is forwarded to `@tauri-apps/plugin-log`
 * which writes the line to stdout, the devtools console, *and* a rolling
 * file at `$HOME/.excalidraw-desktop/excalidraw-desktop.log` (configured
 * in `src-tauri/src/lib.rs`).
 *
 * Outside of Tauri (e.g. `npm run dev` in a browser, vitest, Playwright
 * web-smoke) we fall back to the matching `console.*` method so tests
 * stay readable.
 *
 * `installGlobalLogHandlers()` should be called once at boot. It
 *   - captures `window.onerror` / `unhandledrejection` and logs them
 *   - mirrors `console.warn` / `console.error` into the Tauri log file
 *     so we can see third-party warnings (e.g. React, Excalidraw) when
 *     triaging the user's running app
 *   - logs a startup banner with the user-agent and screen size
 */

type TauriLogModule = typeof import("@tauri-apps/plugin-log");

let tauriLog: TauriLogModule | null = null;
let tauriLogPromise: Promise<TauriLogModule | null> | null = null;
let installed = false;
let originalConsole: {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
} | null = null;

const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // Tauri 2 exposes __TAURI_INTERNALS__ on the global.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Boolean((window as any).__TAURI_INTERNALS__);

async function loadTauriLog(): Promise<TauriLogModule | null> {
  if (!isTauri()) return null;
  if (tauriLog) return tauriLog;
  if (tauriLogPromise) return tauriLogPromise;
  tauriLogPromise = import("@tauri-apps/plugin-log")
    .then((m) => {
      tauriLog = m;
      return m;
    })
    .catch((err) => {
      // Logging itself failed — fall back forever.
      console.warn("logger: failed to load @tauri-apps/plugin-log", err);
      return null;
    });
  return tauriLogPromise;
}

type Level = "debug" | "info" | "warn" | "error";

function consoleFor(level: Level): (...args: unknown[]) => void {
  const c = originalConsole ?? console;
  switch (level) {
    case "debug":
      return c.debug.bind(c);
    case "info":
      return c.info.bind(c);
    case "warn":
      return c.warn.bind(c);
    case "error":
      return c.error.bind(c);
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) {
        return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      }
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function emit(level: Level, args: unknown[]): void {
  const line = formatArgs(args);
  // Always console-log first so devtools shows it immediately even
  // before the dynamic import resolves.
  consoleFor(level)(...args);
  void loadTauriLog().then((m) => {
    if (!m) return;
    try {
      m[level](line);
    } catch {
      /* swallow — never crash the app from inside the logger */
    }
  });
}

export const log = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};

/**
 * Install once at boot. Captures global errors and mirrors console
 * warn/error to the Tauri log file. Safe to call multiple times.
 */
export function installGlobalLogHandlers(): void {
  if (installed) return;
  installed = true;

  // Capture the original console.* before we patch — emit() needs them
  // to avoid infinite recursion.
  originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  // Mirror warn/error from any caller (React, Excalidraw, etc.) into the
  // Tauri file log so we can see what they're complaining about post-hoc.
  if (typeof console !== "undefined") {
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...args: unknown[]) => {
      origWarn(...(args as []));
      void loadTauriLog().then((m) => m?.warn(`[console] ${formatArgs(args)}`));
    };
    console.error = (...args: unknown[]) => {
      origError(...(args as []));
      void loadTauriLog().then((m) => m?.error(`[console] ${formatArgs(args)}`));
    };
  }

  if (typeof window !== "undefined") {
    window.addEventListener("error", (event) => {
      const e = event as ErrorEvent;
      log.error(`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const e = event as PromiseRejectionEvent;
      log.error("unhandledrejection:", e.reason);
    });
  }

  // Startup banner — first thing we want to see in the log file.
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "n/a";
    const dim =
      typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "n/a";
    log.info(`logger: boot ua=${ua} viewport=${dim} tauri=${isTauri()}`);
  } catch {
    /* never crash boot */
  }
}
