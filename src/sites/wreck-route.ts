// The migration client's wreck route (#199, slice 7): where the diver can be,
// as a function of the route position and the depth.
//
// Legacy takes the vertical bounds from the site: ceilingAt() and floorAt()
// over its profiles, its structures stopping the diver (solidAt), and
// overheadAt() for "is there something above me". The migration client draws
// its own provisional hull (src/render/pixi-renderer.ts), and the diver
// follows a route through it, so its bounds come from that drawing. The
// renderer builds its hull polygons from the points below, so what stops the
// diver is what the player sees.
//
// Renderer-neutral on purpose: the controller reads it for the physics, the
// renderer for the drawing, and neither imports the other.

export interface RoutePoint {
  readonly x: number;
  readonly d: number;
}

/** The top of the hull's deck, bow to stern: the floor above the wreck. */
export const WRECK_DECK_TOP: readonly RoutePoint[] = Object.freeze([
  Object.freeze({ x: 22, d: 23 }),
  Object.freeze({ x: 82, d: 21 }),
  Object.freeze({ x: 108, d: 29 }),
]);

/** The underside of the deck: the ceiling inside the wreck. */
export const WRECK_DECK_UNDERSIDE: readonly RoutePoint[] = Object.freeze([
  Object.freeze({ x: 27, d: 24.5 }),
  Object.freeze({ x: 82, d: 23 }),
  Object.freeze({ x: 103, d: 29.5 }),
]);

/** The floor of the hull's interior. */
export const WRECK_HOLD_FLOOR_M = 33.5;
/** The bow and stern ends of the hull's outer bottom, and of its interior floor. */
export const WRECK_KEEL_M = 35;
export const WRECK_BOW_X_M = 14;
export const WRECK_STERN_X_M = 103;
export const WRECK_HOLD_BOW_X_M = 21;
export const WRECK_HOLD_STERN_X_M = 99;

/**
 * The floor in open water beside the wreck: the route's floor since #192,
 * which keeps the diver clear of the seabed the scene draws below it.
 */
export const OPEN_WATER_FLOOR_M = 34;

export const ROUTE_MIN_POSITION_M = 8;
export const ROUTE_MAX_POSITION_M = 106;
/**
 * Where a dive starts and a resumed one picks up: in open water off the bow,
 * clear of the hull, as legacy's dives start at the site's entry beside the
 * boat (src/sites.js entry.x, boatX). Legacy does not save diverX either, so a
 * resumed legacy dive starts at its entry too.
 */
export const ROUTE_START_POSITION_M = 10;

/**
 * Where the overhead starts, and with it the zone map's cargo hold
 * (src/render/renderer.ts selectWreckZone()): the start of the deck's
 * underside, where the drawn hold is under the deck at its full height
 * (#222). Legacy counts any diver with solid structure above as in the
 * overhead (src/sites.js overheadAt), and its main deck covers the hull from
 * x 22 (src/sites.js, the deck after the bow-visor opening), so a diver
 * under the drawn deck is in the overhead. Until #222 it started at 45, and
 * the hold under the deck before that counted as open water.
 */
export const CARGO_HOLD_FROM_M = 27;
export const ENGINE_ROOM_FROM_M = 76;

/**
 * How steep a surface the diver slides along instead of being stopped by it,
 * as a rise over the horizontal distance swum. The deck's long middle runs
 * at about 0.03, so a diver resting on it or under it can still fin along;
 * the stern rises at 0.3, and there the diver has to change depth first, as
 * legacy's flat structures stop a diver who swims into them. The slide moves
 * the depth through the bounds, so it is kept well under legacy's fast-ascent
 * rate: 0.05 at 5 m/s real is 3 m/min of dive time.
 */
export const MAX_SLIDE_SLOPE = 0.05;

/**
 * One connected stretch of water at a route position: its ceiling and floor,
 * and whether it is under the wreck's deck.
 */
export interface RouteSpace {
  readonly ceilingM: number;
  readonly floorM: number;
  readonly inOverhead: boolean;
}

/**
 * The stretches of water at a route position, shallowest first.
 *
 * Outside the hold there is one, from the surface to the floor. Over the hold
 * there are two: above the deck, open to the surface, and below it, under
 * the deck, which is legacy's inOverhead (src/sites.js overheadAt: a solid
 * above the diver).
 */
export function routeSpacesAt(positionM: number): readonly RouteSpace[] {
  if (positionM < CARGO_HOLD_FROM_M) {
    return [{ ceilingM: 0, floorM: OPEN_WATER_FLOOR_M, inOverhead: false }];
  }
  const aboveDeck: RouteSpace = {
    ceilingM: 0,
    floorM: profileAt(WRECK_DECK_TOP, positionM),
    inOverhead: false,
  };
  const ceilingM = profileAt(WRECK_DECK_UNDERSIDE, positionM);
  const floorM = holdFloorAt(positionM);
  // Past the stern wall there is no hold: only water above the deck.
  return floorM > ceilingM
    ? [aboveDeck, { ceilingM, floorM, inOverhead: true }]
    : [aboveDeck];
}

/**
 * The hold's floor, rising along the stern wall the scene draws from the
 * floor's end to where the deck's underside ends (#223 pre-review): the
 * drawn interior closes there, and behind it is solid hull.
 */
export function holdFloorAt(positionM: number): number {
  if (positionM <= WRECK_HOLD_STERN_X_M) {
    return WRECK_HOLD_FLOOR_M;
  }
  const wallTopM = profileAt(WRECK_DECK_UNDERSIDE, WRECK_STERN_X_M);
  const along = (positionM - WRECK_HOLD_STERN_X_M) / (WRECK_STERN_X_M - WRECK_HOLD_STERN_X_M);
  return WRECK_HOLD_FLOOR_M + (wallTopM - WRECK_HOLD_FLOOR_M) * along;
}

/**
 * The stretch of water the diver is in, or the nearest one when the depth is
 * just outside every stretch, which a slide along a gentle slope leaves it.
 * The physics then holds the diver to its bounds.
 */
export function routeSpaceNear(positionM: number, depthM: number): RouteSpace {
  let nearest: RouteSpace | null = null;
  let nearestDistanceM = Number.POSITIVE_INFINITY;
  for (const space of routeSpacesAt(positionM)) {
    const distanceM = distanceOutside(space, depthM);
    if (distanceM < nearestDistanceM) {
      nearest = space;
      nearestDistanceM = distanceM;
    }
  }
  // routeSpacesAt never returns an empty list.
  return nearest as RouteSpace;
}

/**
 * Where a horizontal move from `fromM` towards `toM` at `depthM` ends.
 *
 * Into water, or onto a slope gentle enough to slide along, the move is made
 * in full. Into the hull it is not made at all: legacy's horizontal physics
 * stops the diver at a structure, and the diver has to rise or sink to get
 * past it. The overhead is entered only between the deck and the hold's
 * floor, and the deck is crossed above it.
 *
 * The engine block the scene draws in the hold does not stop the diver
 * (#222): legacy's engines are site features, drawn but never collided with,
 * since its collision reads only the site's structures (src/sites.js
 * solidOverlapArea, src/physics.js updateHorizontalPhysics).
 */
export function moveAlongRoute(fromM: number, toM: number, depthM: number): number {
  const targetM = Math.min(ROUTE_MAX_POSITION_M, Math.max(ROUTE_MIN_POSITION_M, toM));
  if (targetM === fromM) {
    return fromM;
  }
  const slackM = MAX_SLIDE_SLOPE * Math.abs(targetM - fromM);
  const space = routeSpaceNear(targetM, depthM);
  return distanceOutside(space, depthM) <= slackM ? targetM : fromM;
}

function distanceOutside(space: RouteSpace, depthM: number): number {
  if (depthM < space.ceilingM) {
    return space.ceilingM - depthM;
  }
  if (depthM > space.floorM) {
    return depthM - space.floorM;
  }
  return 0;
}

/** Linear between the points, and level beyond either end. */
export function profileAt(points: readonly RoutePoint[], x: number): number {
  const first = points[0] as RoutePoint;
  if (x <= first.x) {
    return first.d;
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as RoutePoint;
    const current = points[index] as RoutePoint;
    if (x <= current.x) {
      return previous.d + ((current.d - previous.d) * (x - previous.x)) / (current.x - previous.x);
    }
  }
  return (points[points.length - 1] as RoutePoint).d;
}
