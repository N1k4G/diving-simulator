// WP-07: renderer-neutral site resources.
//
// Gameplay and presentation are separate documents on purpose. The renderer may
// import presentation; nothing that decides where the diver can swim may. That
// separation is what lets an asset be replaced without a collision review.

import gameplayDocument from "./resources/gameplay.json";
import { deepFreeze } from "./deep-freeze";

export interface ProfilePoint {
  readonly x: number;
  readonly d: number;
}

export interface SiteStructure {
  readonly x1: number;
  readonly x2: number;
  readonly dTop: number;
  readonly dBottom: number;
  readonly kind?: string;
}

export interface BadAirDome {
  readonly x1: number;
  readonly x2: number;
  readonly d?: number;
}

/** Where the diver enters the water. Gameplay data, not a rendering hint. */
export interface SiteEntryPoint {
  readonly x: number;
}

export interface SiteGameplay {
  readonly id: string;
  readonly maxDepth: number;
  readonly hasOverhead: boolean;
  readonly entry: SiteEntryPoint;
  readonly boatX?: number;
  readonly floor: readonly ProfilePoint[];
  readonly ceiling: readonly ProfilePoint[] | null;
  readonly structures: readonly SiteStructure[];
  readonly badAir: readonly BadAirDome[];
  readonly currentBias?: number;
  readonly noShark?: boolean;
}

/**
 * Invariants the JSON Schema cannot express, each of which corrupts geometry
 * silently rather than loudly:
 *
 * - `lerpProfile` walks points assuming ascending `x`. Unsorted input does not
 *   throw; it interpolates against the wrong segment and returns a plausible
 *   depth for the wrong place.
 * - An inverted structure box (`x2 < x1`, `dBottom < dTop`) can never be hit by
 *   `solidAt`, so a wall silently stops existing.
 * - A structure below `maxDepth` is unreachable, which usually means a typo
 *   rather than an intentionally dead volume.
 */
export function validateSiteGameplay(site: SiteGameplay): string[] {
  const problems: string[] = [];

  const checkProfile = (name: string, points: readonly ProfilePoint[] | null): void => {
    if (!points) {
      return;
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1] as ProfilePoint;
      const current = points[index] as ProfilePoint;
      if (current.x <= previous.x) {
        problems.push(
          `${site.id}: ${name} point ${index} has x=${current.x}, not greater than the previous ${previous.x}`,
        );
      }
    }
  };

  checkProfile("floor", site.floor);
  checkProfile("ceiling", site.ceiling);

  site.structures.forEach((structure, index) => {
    if (structure.x2 < structure.x1) {
      problems.push(`${site.id}: structure ${index} has x2 ${structure.x2} before x1 ${structure.x1}`);
    }
    if (structure.dBottom < structure.dTop) {
      problems.push(
        `${site.id}: structure ${index} has dBottom ${structure.dBottom} above dTop ${structure.dTop}`,
      );
    }
    if (structure.dTop > site.maxDepth) {
      problems.push(
        `${site.id}: structure ${index} starts at ${structure.dTop} m, below the site maxDepth ${site.maxDepth} m`,
      );
    }
  });

  site.badAir.forEach((dome, index) => {
    if (dome.x2 < dome.x1) {
      problems.push(`${site.id}: badAir ${index} has x2 ${dome.x2} before x1 ${dome.x1}`);
    }
  });

  return problems;
}

const sites = (gameplayDocument as { sites: Record<string, SiteGameplay> }).sites;

const startupProblems = Object.values(sites).flatMap(validateSiteGameplay);
if (startupProblems.length) {
  // Fail at import time. Invalid geometry that only surfaces when a diver swims
  // into it is far more expensive than a build that refuses to start.
  throw new Error(`invalid site gameplay data:\n${startupProblems.join("\n")}`);
}

export const SITE_GAMEPLAY: Readonly<Record<string, SiteGameplay>> = deepFreeze(sites);

export function siteGameplay(id: string): SiteGameplay | null {
  return SITE_GAMEPLAY[id] ?? null;
}

/**
 * Digest of the inputs these resources were generated from (`src/sites.js`
 * plus the MAX_DEPTH it reads). Not a commit id: generation runs before the
 * commit that carries its own output, so a commit id here would always name a
 * tree whose descriptors produced different data. `npm run sites:check`
 * verifies this value, so it is a claim that can be — and is — checked.
 */
export const SITE_GAMEPLAY_SOURCE_DIGEST = (
  gameplayDocument as { sourceDigest: string }
).sourceDigest;
