// Legacy's shark (src/renderer.js drawScene, TASK-044), at its 0.05 m a
// pixel: shark.size 45 px from the snout's centre to the tail's root, a 4 px
// bob, and a phase that advances 3 a real second (src/game-loop.js). Shared
// by the Pixi scene and the development canvas renderer (#246), so the two
// draw the same shark.

export const LEGACY_M_PER_PX = 0.05;
export const SHARK_SIZE_M = 45 * LEGACY_M_PER_PX;
export const SHARK_BOB_M = 4 * LEGACY_M_PER_PX;
export const SHARK_PHASE_PER_S = 3;
/** Legacy's mouth, stroked 1.5 px wide. */
export const SHARK_MOUTH_WIDTH_M = 1.5 * LEGACY_M_PER_PX;

/**
 * The shark's bob below its depth, in metres: legacy's `sin(phase) * 4` px,
 * on a phase that runs at 3 a real second from when it is first drawn.
 */
export function sharkBobM(sinceFirstDrawnS: number): number {
  return Math.sin(sinceFirstDrawnS * SHARK_PHASE_PER_S) * SHARK_BOB_M;
}
