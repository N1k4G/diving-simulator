import { describe, expect, it } from "vitest";

import { TouchPresses } from "../../src/app/touch-press";

// The context controls' touch bookkeeping (#168 PR 2): which touch went down
// on which button, and which button a lifted touch presses. The DOM half,
// the touch events and the click they keep from counting twice, is driven
// with real touch in tests/touch-context.spec.js.

const over = () => true;
const off = () => false;

describe("TouchPresses", () => {
  it("presses the button a touch went down on and is lifted over, once", () => {
    const presses = new TouchPresses<string>();
    presses.start(1, "torch");
    expect(presses.has(1)).toBe(true);
    expect(presses.end(1, over)).toBe("torch");
    expect(presses.has(1)).toBe(false);
    expect(presses.end(1, over)).toBeNull();
  });

  it("presses nothing for a touch lifted off its button", () => {
    const presses = new TouchPresses<string>();
    presses.start(1, "bailout");
    expect(presses.end(1, off)).toBeNull();
    expect(presses.has(1)).toBe(false);
  });

  it("asks whether the touch is over its own button, not another", () => {
    const presses = new TouchPresses<string>();
    presses.start(1, "cylinder 2");
    const asked: string[] = [];
    presses.end(1, (button) => {
      asked.push(button);
      return true;
    });
    expect(asked).toEqual(["cylinder 2"]);
  });

  it("presses nothing for a touch it never saw go down", () => {
    const presses = new TouchPresses<string>();
    expect(presses.has(4)).toBe(false);
    expect(presses.end(4, over)).toBeNull();
  });

  it("forgets a cancelled touch", () => {
    const presses = new TouchPresses<string>();
    presses.start(1, "setpoint up");
    presses.cancel(1);
    expect(presses.has(1)).toBe(false);
    expect(presses.end(1, over)).toBeNull();
  });

  it("keeps two fingers apart, each pressing its own button", () => {
    // A second finger on a cylinder while the first is on another button.
    const presses = new TouchPresses<string>();
    presses.start(1, "torch");
    presses.start(2, "cylinder 2");
    expect(presses.end(2, over)).toBe("cylinder 2");
    expect(presses.has(1)).toBe(true);
    expect(presses.end(1, off)).toBeNull();
  });
});
