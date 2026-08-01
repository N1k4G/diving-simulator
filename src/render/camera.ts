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

export const WRECK_CAMERA_BOUNDS: Readonly<CameraBounds> = Object.freeze({
  left: 0,
  right: 116,
  top: 10,
  bottom: 40,
});

export function createCameraTransform(
  viewport: Readonly<Viewport>,
  requestedFocus: Readonly<Point>,
  visibleWidthM = 58,
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
