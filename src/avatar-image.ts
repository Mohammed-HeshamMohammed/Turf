// The maths of the profile picture cropper, kept apart from the page so it can be tested: which square of the chosen image is
// shown, and how the result is saved. Any image the browser can open is accepted; what is saved is always a small square JPEG.

/** The saved picture's side in pixels, and the longest data address the auth service accepts for it (140000 characters). */
export const OUTPUT_SIZE = 320;
export const MAX_ENCODED = 130000;
export const MAX_ZOOM = 4;

export type Crop = { zoom: number; cx: number; cy: number }; // cx and cy: the centre of the shown square, as fractions of the image

/** The square of the image that is shown: its top-left corner and side, in image pixels, always inside the image. */
export function cropRect(width: number, height: number, { zoom, cx, cy }: Crop): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height) / Math.min(Math.max(zoom, 1), MAX_ZOOM);
  const clamp = (value: number, high: number) => Math.min(Math.max(value, 0), Math.max(high, 0));
  return { sx: clamp(cx * width - size / 2, width - size), sy: clamp(cy * height - size / 2, height - size), size };
}

/** Moves the crop by a drag of (dx, dy) screen pixels over a view `view` pixels wide; the picture follows the finger. */
export function dragCrop(width: number, height: number, crop: Crop, dx: number, dy: number, view: number): Crop {
  const { size } = cropRect(width, height, crop);
  const perPixel = size / view;
  const moved = { ...crop, cx: crop.cx - (dx * perPixel) / width, cy: crop.cy - (dy * perPixel) / height };
  const { sx, sy } = cropRect(width, height, moved);
  return { ...moved, cx: (sx + size / 2) / width, cy: (sy + size / 2) / height };
}

/** The lowest-quality step is still tried; the first quality whose result fits is used. */
export function qualitySteps(): number[] {
  return [0.92, 0.85, 0.75, 0.65, 0.5, 0.35];
}

export function fitsAvatar(dataUrl: string): boolean {
  return dataUrl.startsWith("data:image/jpeg;base64,") && dataUrl.length - "data:image/jpeg;base64,".length <= MAX_ENCODED;
}
