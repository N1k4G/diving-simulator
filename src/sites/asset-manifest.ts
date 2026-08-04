// WP-07: the asset contract for decorative site content.
//
// Every authored feature kind maps to exactly one asset entry. The mapping is
// hand-authored because it is art direction, but its *completeness* is enforced
// by test: a new feature kind fails the build until someone assigns it an
// asset, rather than silently rendering nothing.
//
// Nothing here may influence collision, air, spawning or currents. Those live
// in the gameplay resource and cannot import this file.

export const LAYERS = [
  "backdrop",
  "terrain",
  "structure",
  "decoration",
  "fauna",
  "foreground",
] as const;

export type LayerId = (typeof LAYERS)[number];

/**
 * Quality tiers exist so a low-end device drops decoration before it drops the
 * things a diver navigates by. Ordered cheapest first; a tier renders every
 * asset whose minimum tier is at or below it.
 */
export const QUALITY_TIERS = ["low", "medium", "high"] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

export interface AssetEntry {
  /** Stable id. Atlas frames are addressed by this, not by feature kind. */
  readonly id: string;
  readonly atlas: string;
  readonly frame: string;
  readonly layer: LayerId;
  readonly minimumQualityTier: QualityTier;
}

function entry(
  id: string,
  atlas: string,
  layer: LayerId,
  minimumQualityTier: QualityTier = "low",
): AssetEntry {
  // Atlas frame names follow `<kind>` within `<atlas>`, so a frame can be
  // repacked or re-authored without touching site data or this table.
  return { id, atlas, frame: id.split("/")[1] ?? id, layer, minimumQualityTier };
}

export const ASSET_MANIFEST: Readonly<Record<string, AssetEntry>> = Object.freeze({
  // shore
  buoy: entry("shore/buoy", "shore", "foreground"),
  towel: entry("shore/towel", "shore", "decoration", "medium"),
  umbrella: entry("shore/umbrella", "shore", "decoration", "medium"),
  seagrass: entry("shore/seagrass", "shore", "decoration", "low"),
  coral: entry("shore/coral", "shore", "decoration", "medium"),
  anchor: entry("shared/anchor", "shared", "structure"),

  // reef
  tableCoral: entry("reef/tableCoral", "reef", "decoration"),
  brainCoral: entry("reef/brainCoral", "reef", "decoration"),
  staghorn: entry("reef/staghorn", "reef", "decoration", "medium"),
  softCoral: entry("reef/softCoral", "reef", "decoration", "medium"),
  anthiasCloud: entry("reef/anthiasCloud", "reef", "fauna", "high"),
  gorgonian: entry("reef/gorgonian", "reef", "decoration", "medium"),
  barrelSponge: entry("reef/barrelSponge", "reef", "decoration"),

  // wreck
  helm: entry("wreck/helm", "wreck", "structure"),
  lightShaft: entry("wreck/lightShaft", "wreck", "foreground", "medium"),
  messTable: entry("wreck/messTable", "wreck", "decoration", "medium"),
  lifeboat: entry("wreck/lifeboat", "wreck", "structure"),
  bowVisor: entry("wreck/bowVisor", "wreck", "structure"),
  lorry: entry("wreck/lorry", "wreck", "structure"),
  car: entry("wreck/car", "wreck", "structure"),
  bunk: entry("wreck/bunk", "wreck", "decoration", "medium"),
  container: entry("wreck/container", "wreck", "structure"),
  engine: entry("wreck/engine", "wreck", "structure"),
  rustHole: entry("wreck/rustHole", "wreck", "decoration"),
  line: entry("shared/line", "shared", "foreground"),
  net: entry("wreck/net", "wreck", "decoration", "medium"),

  // cave
  pond: entry("cave/pond", "cave", "backdrop"),
  warningSign: entry("cave/warningSign", "cave", "foreground"),
  caveColumn: entry("cave/caveColumn", "cave", "structure"),
});

export function assetFor(featureKind: string): AssetEntry | null {
  return ASSET_MANIFEST[featureKind] ?? null;
}

export function atlasesFor(featureKinds: Iterable<string>): string[] {
  const atlases = new Set<string>();
  for (const kind of featureKinds) {
    const asset = assetFor(kind);
    if (asset) {
      atlases.add(asset.atlas);
    }
  }
  return [...atlases].sort();
}

export function tierAllows(tier: QualityTier, minimum: QualityTier): boolean {
  return QUALITY_TIERS.indexOf(tier) >= QUALITY_TIERS.indexOf(minimum);
}
