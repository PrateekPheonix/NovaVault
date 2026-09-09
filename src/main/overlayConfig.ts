/**
 * Overlay window configuration (PRD §21).
 *
 * Kept as a pure function so the window contract is testable without booting Electron.
 * Every non-obvious flag here is load-bearing on macOS; the reasoning is inline because
 * these are exactly the settings that get "cleaned up" later by someone who doesn't know
 * why they were set.
 */

/** Structural subset of Electron's BrowserWindowConstructorOptions that we set. */
export interface OverlayWindowOptions {
  width: number;
  height: number;
  frame: boolean;
  transparent: boolean;
  hasShadow: boolean;
  resizable: boolean;
  skipTaskbar: boolean;
  alwaysOnTop: boolean;
  focusable: boolean;
  show: boolean;
  acceptFirstMouse: boolean;
  webPreferences: {
    contextIsolation: boolean;
    nodeIntegration: boolean;
    sandbox: boolean;
  };
}

/**
 * Calls that must run *after* construction, because Electron exposes no constructor
 * equivalent. Returned as data so tests can assert on them.
 */
export interface OverlayPostCreateStep {
  method:
    | "setAlwaysOnTop"
    | "setVisibleOnAllWorkspaces"
    | "setContentProtection"
    | "setWindowButtonVisibility";
  args: readonly unknown[];
  why: string;
}

export interface OverlayPlan {
  options: OverlayWindowOptions;
  postCreate: readonly OverlayPostCreateStep[];
}

export interface OverlayPlanInput {
  width?: number;
  height?: number;
  /**
   * §21's privacy requirement: the overlay should not appear in ordinary user-selected
   * screen sharing. Maps to NSWindow.sharingType = .none on macOS.
   *
   * This is NOT an anti-detection measure — §21 and §63 rule that out explicitly. It is a
   * documented AppKit capability, and it is the user's own screen being shared.
   */
  contentProtection?: boolean;
  platform?: NodeJS.Platform;
}

export const OVERLAY_DEFAULTS = {
  width: 420,
  height: 320,
  contentProtection: true,
} as const;

export function buildOverlayPlan(input: OverlayPlanInput = {}): OverlayPlan {
  const width = input.width ?? OVERLAY_DEFAULTS.width;
  const height = input.height ?? OVERLAY_DEFAULTS.height;
  const contentProtection = input.contentProtection ?? OVERLAY_DEFAULTS.contentProtection;
  const platform = input.platform ?? process.platform;
  const isMac = platform === "darwin";

  const options: OverlayWindowOptions = {
    width,
    height,
    // A chromeless, shadowless panel - it should read as a HUD, not an app window.
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    // Keep it out of the Dock/taskbar and the app switcher.
    skipTaskbar: true,
    alwaysOnTop: true,
    // Load-bearing: the overlay must never steal focus from the meeting or the editor.
    // A focused overlay would swallow keystrokes mid-interview.
    focusable: false,
    // Shown deliberately once content is ready, to avoid a white flash.
    show: false,
    // Let a click act on the overlay without first focusing it.
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  const postCreate: OverlayPostCreateStep[] = [
    {
      method: "setAlwaysOnTop",
      // "screen-saver" is the highest standard level; plain alwaysOnTop still sits below
      // fullscreen video windows, which is precisely when the overlay is needed.
      args: [true, "screen-saver"],
      why: "stay above fullscreen conferencing windows",
    },
    {
      method: "setVisibleOnAllWorkspaces",
      // visibleOnFullScreenSpaces is the critical half: macOS puts a fullscreen app in its
      // own Space, and without this the overlay simply vanishes when the call goes
      // fullscreen - the default state for most interviews.
      args: [true, { visibleOnFullScreenSpaces: true }],
      why: "survive the fullscreen Space a call creates",
    },
  ];

  if (contentProtection) {
    postCreate.push({
      method: "setContentProtection",
      args: [true],
      why: "§21 privacy requirement; NSWindow.sharingType = .none on macOS",
    });
  }

  if (isMac) {
    postCreate.push({
      method: "setWindowButtonVisibility",
      args: [false],
      why: "no traffic lights on a frameless HUD",
    });
  }

  return { options, postCreate };
}
