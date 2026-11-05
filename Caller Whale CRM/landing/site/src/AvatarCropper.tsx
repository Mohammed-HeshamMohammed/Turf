import { useEffect, useRef, useState } from "react";
import { FORMATS, MAX_ZOOM, cropRect, dragCrop, fitsAvatar, outputSide, shrinkSteps, type Crop } from "./avatar-image.ts";

const VIEW = 280; // the cropping window, in pixels

/** Opens any image the browser can read, lets the person move and zoom a square over it, and hands back a small square JPEG. */
export function AvatarCropper({ file, onCancel, onDone }: { file: File; onCancel: () => void; onDone: (dataUrl: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState("");
  const [crop, setCrop] = useState<Crop>({ zoom: 1, cx: 0.5, cy: 0.5 });

  useEffect(() => {
    let active = true;
    let opened: ImageBitmap | null = null;
    createImageBitmap(file, { imageOrientation: "from-image" }).then(bitmap => {
      if (active) { opened = bitmap; setImage(bitmap); } else bitmap.close();
    }).catch(() => { if (active) setError("This image could not be opened. Try a PNG, JPEG, WebP or GIF."); });
    return () => { active = false; opened?.close(); };
  }, [file]);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!image || !context) return;
    const { sx, sy, size } = cropRect(image.width, image.height, crop);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, VIEW, VIEW);
    context.drawImage(image, sx, sy, size, size, 0, 0, VIEW, VIEW);
  }, [image, crop]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onCancel]);

  // The cropped square keeps its own pixels. It is only written in another form (PNG, which loses nothing); if that is too big
  // for the server it becomes a near-lossless JPEG, and only if that is still too big is it made smaller.
  const use = () => {
    if (!image) return;
    const { sx, sy, size } = cropRect(image.width, image.height, crop);
    for (const shrink of shrinkSteps) {
      const side = outputSide(Math.min(size, 512) * shrink);
      const out = document.createElement("canvas");
      out.width = out.height = side;
      const context = out.getContext("2d");
      if (!context) { setError("This browser cannot prepare the picture."); return; }
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#fff"; // used only if a JPEG is needed, which has no transparency
      const png = FORMATS[0]!;
      for (const format of FORMATS) {
        context.clearRect(0, 0, side, side);
        if (format !== png) context.fillRect(0, 0, side, side);
        context.drawImage(image, sx, sy, size, size, 0, 0, side, side);
        const dataUrl = out.toDataURL(format.type, format.quality);
        if (fitsAvatar(dataUrl)) { onDone(dataUrl); return; }
      }
    }
    setError("This picture could not be prepared. Try a different one.");
  };

  const move = (dx: number, dy: number) => { if (image) setCrop(previous => dragCrop(image.width, image.height, previous, dx, dy, VIEW)); };
  const nudge = (event: React.KeyboardEvent) => {
    const step = 12;
    const keys: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const delta = keys[event.key];
    if (delta) { event.preventDefault(); move(delta[0], delta[1]); }
  };

  return (
    <div className="cropper-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="cropper card" role="dialog" aria-modal="true" aria-labelledby="cropper-title">
        <h2 id="cropper-title">Adjust your picture</h2>
        <p className="muted">Drag to move the picture and use the slider to zoom. The circle is what people see.</p>
        {error ? <p role="alert" className="notice bad">{error}</p> : (
          <>
            <div className="cropper-window" style={{ width: VIEW, height: VIEW }}>
              <canvas ref={canvas} width={VIEW} height={VIEW} tabIndex={0} aria-label="Picture position. Use the arrow keys to move it."
                onKeyDown={nudge}
                onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={event => { if (!drag.current) return; move(event.clientX - drag.current.x, event.clientY - drag.current.y); drag.current = { x: event.clientX, y: event.clientY }; }}
                onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
              <span className="cropper-mask" aria-hidden="true" />
            </div>
            <label className="cropper-zoom">Zoom
              <input type="range" min="1" max={MAX_ZOOM} step="0.01" value={crop.zoom} disabled={!image}
                onChange={event => { const zoom = Number(event.target.value); setCrop(previous => image ? dragCrop(image.width, image.height, { ...previous, zoom }, 0, 0, VIEW) : previous); }} />
            </label>
          </>
        )}
        <div className="cropper-actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          {!error && <button type="button" className="button primary" disabled={!image} onClick={use}>Use this picture</button>}
        </div>
      </div>
    </div>
  );
}
