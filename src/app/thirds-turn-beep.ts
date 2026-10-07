/**
 * Whether legacy's playAlertBeep() for the rule of thirds is due on this
 * frame (#199): src/game-loop.js beeps once, on the tick thirdsTurnWarned
 * latches at the turn. `previous` is the latch on the frame before, or null
 * before the first frame: a dive resumed past its turn latched long ago and
 * does not beep again on resuming.
 */
export function isTurnBeepDue(previous: boolean | null, current: boolean): boolean {
  return previous === false && current;
}
