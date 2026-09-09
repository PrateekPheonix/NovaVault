import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOverlayPlan, OVERLAY_DEFAULTS } from "../src/main/overlayConfig.ts";

const stepFor = (plan: ReturnType<typeof buildOverlayPlan>, method: string) =>
  plan.postCreate.find((s) => s.method === method);

describe("buildOverlayPlan", () => {
  describe("flags that are load-bearing on macOS", () => {
    test("the overlay is never focusable", () => {
      // A focusable overlay would swallow keystrokes meant for the call or the editor.
      assert.equal(buildOverlayPlan().options.focusable, false);
    });

    test("always-on-top is raised to the screen-saver level", () => {
      // Plain alwaysOnTop still sits *below* fullscreen video windows - exactly when the
      // overlay is needed most.
      const step = stepFor(buildOverlayPlan({ platform: "darwin" }), "setAlwaysOnTop");
      assert.ok(step);
      assert.deepEqual(step.args, [true, "screen-saver"]);
    });

    test("the overlay survives the fullscreen Space a call creates", () => {
      // macOS gives a fullscreen app its own Space; without visibleOnFullScreenSpaces the
      // overlay silently disappears the moment the interview goes fullscreen.
      const step = stepFor(buildOverlayPlan({ platform: "darwin" }), "setVisibleOnAllWorkspaces");
      assert.ok(step);
      assert.deepEqual(step.args, [true, { visibleOnFullScreenSpaces: true }]);
    });

    test("traffic lights are hidden on macOS only", () => {
      assert.ok(stepFor(buildOverlayPlan({ platform: "darwin" }), "setWindowButtonVisibility"));
      assert.equal(stepFor(buildOverlayPlan({ platform: "win32" }), "setWindowButtonVisibility"), undefined);
    });
  });

  describe("content protection (§21)", () => {
    test("is requested by default", () => {
      assert.equal(OVERLAY_DEFAULTS.contentProtection, true);
      const step = stepFor(buildOverlayPlan({ platform: "darwin" }), "setContentProtection");
      assert.ok(step);
      assert.deepEqual(step.args, [true]);
    });

    test("can be turned off", () => {
      const plan = buildOverlayPlan({ contentProtection: false, platform: "darwin" });
      assert.equal(stepFor(plan, "setContentProtection"), undefined);
    });
  });

  describe("window chrome", () => {
    test("is a frameless, shadowless, non-resizable HUD", () => {
      const o = buildOverlayPlan().options;
      assert.equal(o.frame, false);
      assert.equal(o.transparent, true);
      assert.equal(o.hasShadow, false);
      assert.equal(o.resizable, false);
      assert.equal(o.skipTaskbar, true);
    });

    test("starts hidden so there is no white flash before content loads", () => {
      assert.equal(buildOverlayPlan().options.show, false);
    });

    test("honours custom dimensions and defaults otherwise", () => {
      assert.equal(buildOverlayPlan().options.width, OVERLAY_DEFAULTS.width);
      const o = buildOverlayPlan({ width: 500, height: 200 }).options;
      assert.equal(o.width, 500);
      assert.equal(o.height, 200);
    });
  });

  describe("renderer hardening", () => {
    test("the renderer is sandboxed with no Node access", () => {
      const wp = buildOverlayPlan().options.webPreferences;
      assert.equal(wp.contextIsolation, true);
      assert.equal(wp.nodeIntegration, false);
      assert.equal(wp.sandbox, true);
    });
  });

  test("every post-create step documents why it exists", () => {
    // These are the settings most likely to be "tidied up" by someone who doesn't know
    // what breaks. The rationale travels with them.
    for (const step of buildOverlayPlan({ platform: "darwin" }).postCreate) {
      assert.ok(step.why.length > 10, `${step.method} needs a rationale`);
    }
  });
});
