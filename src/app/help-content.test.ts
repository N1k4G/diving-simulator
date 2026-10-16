import { describe, expect, it } from "vitest";

import { helpPausesDive, helpSections, type HelpContext } from "./help-content";
import { translate } from "./i18n/catalog";

// The help overlay (#160) lists the controls this client has, per state and
// per what the dive offers, as the HUD shows the controls themselves.

const rec: HelpContext = { state: "diving", gasInfo: false, switchableCylinders: 1, loopControls: false };
const actions = (context: HelpContext) =>
  helpSections(context).map((section) => section.rows.map((row) => row.action));

describe("the help overlay's controls", () => {
  it("lists a recreational dive's controls, with no cylinder keys, I or loop", () => {
    expect(actions(rec)).toEqual([[
      "wreck.controls.ascend", "wreck.controls.descend", "wreck.controls.left", "wreck.controls.right",
      "wreck.controls.torch", "wreck.controls.fastForward", "wreck.controls.mute",
      "help.action.help", "help.action.close",
    ]]);
  });

  it("adds 1–n and I on a technical dive, the setpoint and bailout on the loop only", () => {
    const [tec] = helpSections({ ...rec, gasInfo: true, switchableCylinders: 3 });
    const cylinders = tec?.rows.find((row) => row.action === "help.action.cylinder");
    expect(translate("en", cylinders!.keys).replace("{n}", String(cylinders!.count))).toBe("1–3");
    expect(tec?.rows.map((row) => row.action)).toContain("wreck.gasInfo.open");

    const loop = { ...rec, gasInfo: true, switchableCylinders: 0, loopControls: true };
    expect(actions(loop)[0]).toEqual(expect.arrayContaining(["help.action.setpoint", "wreck.controls.bailout"]));
    expect(actions(loop)[0]).not.toContain("help.action.cylinder");
    expect(actions({ ...loop, loopControls: false })[0]).not.toContain("wreck.controls.bailout");
  });

  it("leads with S at the surface and Enter after the dive, then the dive's controls", () => {
    const surface = helpSections({ ...rec, state: "surface" });
    expect(surface.map((section) => section.headingKey)).toEqual(["help.section.surface", "help.section.dive"]);
    expect(surface[0]?.rows.map((row) => row.keys)).toEqual(["help.keys.descend", "help.keys.help", "help.keys.close"]);
    const postDive = helpSections({ ...rec, state: "post-dive" });
    expect(postDive.map((section) => section.headingKey)).toEqual(["help.section.postDive", "help.section.dive"]);
    expect(postDive[0]?.rows[0]?.keys).toBe("help.keys.diveAgain");
  });

  it("stops the dive under water only, as legacy skips updateDiving() while showHelp", () => {
    expect([helpPausesDive("diving"), helpPausesDive("surface"), helpPausesDive("post-dive")]).toEqual([true, false, false]);
  });

  it("carries legacy's buoyancy warning and close line, word for word in both languages", () => {
    expect(translate("en", "help.buoyancy")).toBe(
      "Buoyancy changes depth gradually — do NOT over-inflate near the surface or a runaway ascent can cause lung barotrauma.",
    );
    expect(translate("de", "help.buoyancy")).toBe(
      "Auftrieb verändert die Tiefe graduell — BCD nahe der Oberfläche NICHT überfüllen, sonst kann ein unkontrollierter Aufstieg ein Lungenbarotrauma auslösen.",
    );
    expect(translate("de", "help.closeHint")).toBe("H, ? oder ESC zum Schließen");
  });
});
