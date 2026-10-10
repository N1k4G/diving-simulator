export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface CameraBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface CameraTransform {
  readonly focus: Point;
  readonly scale: number;
  readonly viewport: Viewport;
}

/**
 * What the camera may show. The top is above the surface (#199): the dive
 * starts and ends there, so the view has to reach it, with a band of sky
 * above as legacy draws it.
 */
export const WRECK_CAMERA_BOUNDS: Readonly<CameraBounds> = Object.freeze({
  left: 0,
  right: 116,
  top: -6,
  bottom: 40,
});

/** The wreck camera shows this many metres across, whatever the viewport. */
export const WRECK_VISIBLE_WIDTH_M = 58;
/**
 * How far the wreck camera looks ahead of the diver, in the direction they
 * face. Legacy centres the diver (DIVER_SCREEN_X_FRACTION 0.5).
 */
export const WRECK_CAMERA_LEAD_M = 8;

/** Where the wreck camera is asked to look, before the scene's bounds. */
export function wreckCameraFocusX(positionM: number, facing: -1 | 1): number {
  return positionM + facing * WRECK_CAMERA_LEAD_M;
}

/**
 * How far the wreck camera shows to either side of the diver, in metres
 * (#219): its lead, and its focus held inside the scene's bounds as
 * createCameraTransform holds it. The width does not depend on the
 * viewport, so neither does this.
 */
export function wreckViewAround(
  positionM: number,
  facing: -1 | 1,
): { readonly leftM: number; readonly rightM: number } {
  const bounds = WRECK_CAMERA_BOUNDS;
  const halfWidthM = WRECK_VISIBLE_WIDTH_M / 2;
  const focusX = clampFocus(
    wreckCameraFocusX(positionM, facing),
    bounds.left + halfWidthM,
    bounds.right - halfWidthM,
    (bounds.left + bounds.right) / 2,
  );
  return {
    leftM: positionM - (focusX - halfWidthM),
    rightM: focusX + halfWidthM - positionM,
  };
}

export function createCameraTransform(
  viewport: Readonly<Viewport>,
  requestedFocus: Readonly<Point>,
  visibleWidthM = WRECK_VISIBLE_WIDTH_M,
  bounds: Readonly<CameraBounds> = WRECK_CAMERA_BOUNDS,
): CameraTransform {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    visibleWidthM <= 0
  ) {
    throw new RangeError("camera dimensions must be positive");
  }

  const scale = viewport.width / visibleWidthM;
  const visibleHeightM = viewport.height / scale;
  const halfWidthM = visibleWidthM / 2;
  const halfHeightM = visibleHeightM / 2;
  const focus = Object.freeze({
    x: clampFocus(
      requestedFocus.x,
      bounds.left + halfWidthM,
      bounds.right - halfWidthM,
      (bounds.left + bounds.right) / 2,
    ),
    y: clampFocus(
      requestedFocus.y,
      bounds.top + halfHeightM,
      bounds.bottom - halfHeightM,
      (bounds.top + bounds.bottom) / 2,
    ),
  });

  return Object.freeze({
    focus,
    scale,
    viewport: Object.freeze({ ...viewport }),
  });
}

export function worldToScreen(
  point: Readonly<Point>,
  camera: Readonly<CameraTransform>,
): Point {
  return Object.freeze({
    x:
      (point.x - camera.focus.x) * camera.scale +
      camera.viewport.width / 2,
    y:
      (point.y - camera.focus.y) * camera.scale +
      camera.viewport.height / 2,
  });
}

function clampFocus(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (minimum > maximum) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
