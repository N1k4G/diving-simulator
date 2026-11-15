import { ROUTE_START_POSITION_M, resumedPosition } from "../sites/wreck-site";

/**
 * The game session's snapshot (#137 A4b): what the controller owns beside
 * the model's DiveState and a reloaded dive gives back, saved with it since
 * v21. Ownership rules:
 *
 * - Depth has one owner, `DiveState.depthM`, the last step the model took.
 *   The controller advances the model once per display frame (#192) and
 *   draws the diver at the model's depth, so there is no view or controlled
 *   depth between steps, and the snapshot carries none: a resumed dive is
 *   drawn where its state is, and nothing restored can move the state.
 * - The position along x is the controller's alone; the model never keeps
 *   one. It is resumed only where the diver fits among the wreck's
 *   structures at the state's depth and could have swum to (resumedPosition,
 *   #240): the depth decides, and a position it rules out goes back to the
 *   route's start. Only for a save with no position the
 *   depth allows does the controller then move the depth, explicitly, to
 *   the start's floor (withinRoute in src/app/game-controller.ts, #206).
 * - Facing and torch are the controller's, and resumed as saved.
 * - Not in it, on purpose: the controller's real time, `elapsedRealS`,
 *   which only times the scene's animation (waves, bubbles, the boat and
 *   shark bobbing, the alarm's pulse and the chevrons' blink), the breath
 *   and bubble sounds' cadence (src/audio/audio-service.ts) and the
 *   forecast's age, whose forecast a reload does not keep either; the held
 *   controls, so no control is held after a restore; the fast-forward,
 *   which legacy does not save.
 *
 * Each field is checked on its own and one that is not what the controller
 * writes costs only itself, as the route position has since v18. Anything
 * else a payload carries is dropped.
 */
export interface SessionSnapshot {
  /** Where along the wreck the diver is (#222), among its structures since v22 (#240). */
  readonly routePositionM: number;
  /** The way the diver faces: legacy's `_diverFacing`, right 1, left -1. */
  readonly facing: -1 | 1;
  /** Legacy's `torchOn` (D6): on by default at a site with an overhead. */
  readonly torchOn: boolean;
}

/**
 * A new dive's session: at the route's start, facing right as legacy's
 * renderer starts (`_diverFacing = 1`), the torch on, as legacy's at a site
 * with an overhead, which the wreck, the only site that renders, is.
 */
export const START_SESSION: SessionSnapshot = Object.freeze({
  routePositionM: ROUTE_START_POSITION_M,
  facing: 1,
  torchOn: true,
});

/** The session a dive at `depthM` resumes from `candidate`, field by field. */
export function resumedSession(candidate: unknown, depthM: number): SessionSnapshot {
  const fields: Partial<Record<keyof SessionSnapshot, unknown>> =
    typeof candidate === "object" && candidate !== null ? candidate : {};
  return Object.freeze({
    routePositionM: resumedPosition(fields.routePositionM, depthM),
    facing: fields.facing === -1 || fields.facing === 1 ? fields.facing : START_SESSION.facing,
    torchOn: typeof fields.torchOn === "boolean" ? fields.torchOn : START_SESSION.torchOn,
  });
}
