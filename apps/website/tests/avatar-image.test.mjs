import assert from "node:assert/strict";
import test from "node:test";
import { cropRect, dragCrop, fitsAvatar, outputSide, FORMATS, shrinkSteps, MAX_ENCODED } from "../src/avatar-image.ts";

test("the crop is a square of the shorter side at zoom 1, centred", () => {
  assert.deepEqual(cropRect(800, 400, { zoom: 1, cx: 0.5, cy: 0.5 }), { sx: 200, sy: 0, size: 400 });
});

test("zooming in shows a smaller square, and it never leaves the image", () => {
  const rect = cropRect(800, 400, { zoom: 2, cx: 0, cy: 1 });
  assert.equal(rect.size, 200);
  assert.deepEqual([rect.sx, rect.sy], [0, 200]);
  assert.equal(cropRect(100, 100, { zoom: 99, cx: 0.5, cy: 0.5 }).size, 25);
});

test("dragging moves the picture with the pointer and stops at the edge", () => {
  const start = { zoom: 2, cx: 0.5, cy: 0.5 };
  const moved = dragCrop(800, 400, start, -50, 0, 280); // drag left: the view moves right
  assert.ok(moved.cx > 0.5);
  const edge = dragCrop(800, 400, start, 100000, 0, 280);
  assert.equal(cropRect(800, 400, edge).sx, 0);
});

test("the picture keeps its size, is never enlarged, and is only reduced past what is ever shown", () => {
  assert.equal(outputSide(200), 200);
  assert.equal(outputSide(511.6), 512);
  assert.equal(outputSide(3000), 512);
  assert.equal(outputSide(0), 1);
});

test("lossless PNG is tried first, and JPEG starts almost lossless", () => {
  assert.equal(FORMATS[0].type, "image/png");
  assert.ok(FORMATS.slice(1).every(format => format.type === "image/jpeg" && format.quality >= 0.85));
  assert.equal(shrinkSteps[0], 1);
});

test("only a PNG or JPEG small enough for the server fits", () => {
  assert.equal(fitsAvatar("data:image/png;base64," + "A".repeat(1000)), true);
  assert.equal(fitsAvatar("data:image/jpeg;base64," + "A".repeat(MAX_ENCODED)), true);
  assert.equal(fitsAvatar("data:image/jpeg;base64," + "A".repeat(MAX_ENCODED + 1)), false);
  assert.equal(fitsAvatar("data:image/webp;base64,AAAA"), false);
});
