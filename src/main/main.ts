/**
 * Electron main process — Phase 1 overlay shell (PRD §21, §22).
 *
 * Run with --verify to boot the window, assert its runtime flags, print a JSON report and
 * exit. That mode exists because the overlay's important properties are invisible: a
 * window that quietly lost `visibleOnFullScreenSpaces` looks perfect until someone
 * fullscreens a call.
 */
import { app, BrowserWindow } from "electron";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayPlan } from "./overlayConfig.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = process.argv.includes("--verify");
// Lets the content-protection check capture a with/without pair to compare.
const NO_PROTECT = process.argv.includes("--no-content-protection");

function createOverlay(): BrowserWindow {
  const plan = buildOverlayPlan({ contentProtection: !NO_PROTECT });
  const win = new BrowserWindow(plan.options);

  for (const step of plan.postCreate) {
    const fn = (win as unknown as Record<string, unknown>)[step.method];
    if (typeof fn !== "function") {
      console.warn(`[overlay] ${step.method} unavailable on this Electron build`);
      continue;
    }
    (fn as (...a: unknown[]) => unknown).apply(win, [...step.args]);
  }

  void win.loadFile(path.join(HERE, "..", "renderer", "overlay.html"));
  return win;
}

/**
 * Report on the properties that actually matter. Electron exposes getters for most of
 * them; content protection is write-only, which is called out rather than glossed over.
 */
function verify(win: BrowserWindow): Record<string, unknown> {
  const plan = buildOverlayPlan();
  return {
    platform: process.platform,
    electron: process.versions.electron,
    checks: {
      alwaysOnTop: win.isAlwaysOnTop(),
      visibleOnAllWorkspaces: win.isVisibleOnAllWorkspaces(),
      focusable: win.isFocusable(),
      resizable: win.isResizable(),
    },
    expected: {
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      focusable: false, // must not steal keystrokes from the call
      resizable: false,
    },
    contentProtection: {
      requested: plan.postCreate.some((s) => s.method === "setContentProtection"),
      // Electron has no isContentProtectionEnabled(); the only honest check is to take a
      // screenshot and look. See the spike README.
      verifiable: false,
      note: "write-only in Electron; verify empirically with screencapture",
    },
  };
}

app.whenReady().then(() => {
  const win = createOverlay();

  if (VERIFY) {
    const report = () => {
      const r = verify(win);
      console.log(JSON.stringify(r, null, 2));
      const c = r["checks"] as Record<string, boolean>;
      const e = r["expected"] as Record<string, boolean>;
      const failed = Object.keys(e).filter((k) => c[k] !== e[k]);
      if (failed.length > 0) {
        console.error(`\nFAIL: ${failed.join(", ")}`);
        app.exit(1);
      } else {
        console.log("\nPASS: all overlay window flags match expectations");
        app.exit(0);
      }
    };
    win.once("ready-to-show", report);
    // Don't hang forever if ready-to-show never fires (no display, sandboxed CI, etc.).
    setTimeout(() => {
      console.error("FAIL: window never became ready (no display?)");
      app.exit(2);
    }, 10_000);
    return;
  }

  win.once("ready-to-show", () => win.showInactive()); // showInactive: never take focus
});

app.on("window-all-closed", () => app.quit());
