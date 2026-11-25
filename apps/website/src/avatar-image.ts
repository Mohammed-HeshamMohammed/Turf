// The maths of the profile picture cropper, kept apart from the page so it can be tested: which square of the chosen image is
// shown, and how the result is saved. Any image the browser can open is accepted; what is saved is always a small square JPEG.

/** The largest side sent, in pixels (the picture is shown at 150 px at most, so this is twice that and a little more; auth keeps
 *  the same), and the longest data address the auth service accepts (668000 characters, about 500 KB of image; it keeps far less). */
export const MAX_SIDE = 320;
export const MAX_ENCODED = 668000;
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

/** The picture's side: the cropped square as it is, never enlarged, and only reduced when it is bigger than is ever shown. */
export function outputSide(cropSide: number): number {
  return Math.max(1, Math.min(Math.round(cropSide), MAX_SIDE));
}

/** How the picture is written, best first: PNG keeps every pixel as it is, so it comes first; JPEG is only for a picture whose
 *  PNG does not fit, and starts almost lossless. Making it smaller instead is the last resort (see `shrinkSteps`). */
export const FORMATS: { type: "image/png" | "image/jpeg"; quality?: number }[] = [
  { type: "image/png" },
  { type: "image/jpeg", quality: 0.97 },
  { type: "image/jpeg", quality: 0.92 },
  { type: "image/jpeg", quality: 0.85 },
];

/** When even JPEG does not fit, the same picture is tried at these fractions of its size. */
export const shrinkSteps = [1, 0.85, 0.7, 0.55];

export function fitsAvatar(dataUrl: string): boolean {
  const body = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return /^data:image\/(png|jpeg);base64,/.test(dataUrl) && body.length <= MAX_ENCODED;
}
