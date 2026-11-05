import assert from "node:assert/strict";
import test from "node:test";
import { cropRect, dragCrop, fitsAvatar, MAX_ENCODED } from "../src/avatar-image.ts";

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

test("only a small enough JPEG fits", () => {
  assert.equal(fitsAvatar("data:image/jpeg;base64," + "A".repeat(1000)), true);
  assert.equal(fitsAvatar("data:image/jpeg;base64," + "A".repeat(MAX_ENCODED + 1)), false);
  assert.equal(fitsAvatar("data:image/png;base64,AAAA"), false);
});
