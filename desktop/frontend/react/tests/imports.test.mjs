import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/remote/api.ts";
import { SOURCE_IMPORT_FIELDS, follow, mappingBody, mappingProblem, sha256Hex, uploadFile } from "../src/remote/imports.ts";

const file = (size, name = "owners.csv") =>
  Object.assign(new Blob([new Uint8Array(size).map((_, i) => i % 251)]), {
    name,
  });

/** A server that holds pieces in memory and checks fingerprints the way crm-core does. */
function fakeServer({ chunk = 10, held = [], fail = {} } = {}) {
  const calls = { pieces: [], completed: 0, inFlight: 0, peak: 0 };
  const stored = new Map();
  return {
    calls,
    stored,
    api: {
      start: async (body) => ({
        id: "job-1",
        status: "uploading",
        chunk_size: chunk,
        total_chunks: Math.ceil(body.size / chunk),
        size: body.size,
        received: held,
      }),
      get: async (id) => ({
        id,
        status: "uploading",
        chunk_size: chunk,
        total_chunks: Math.ceil(35 / chunk),
        size: 35,
        received: held,
      }),
      piece: async (id, n, bytes, sha) => {
        calls.inFlight += 1;
        calls.peak = Math.max(calls.peak, calls.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.inFlight -= 1;
        calls.pieces.push(n);
        if (fail[n]-- > 0) throw fail.error ?? new ApiError(0, "offline", "The server cannot be reached");
        assert.equal(await sha256Hex(bytes), sha, "the fingerprint matches the bytes");
        stored.set(n, bytes.byteLength);
        return { n, stored: true };
      },
      complete: async (id) => ({ id, status: "queued" }),
    },
  };
}

test("a file goes up in the pieces the server names, a few at a time, each as long as it should be", async () => {
  const server = fakeServer();
  const progress = [];
  const job = await uploadFile(file(35), {
    api: server.api,
    onProgress: (p) => progress.push(p.sent),
  });
  assert.equal(job.status, "queued");
  assert.deepEqual(
    [...server.stored].sort((a, b) => a[0] - b[0]),
    [
      [0, 10],
      [1, 10],
      [2, 10],
      [3, 5],
    ],
  );
  assert.ok(server.calls.peak > 1 && server.calls.peak <= 4, "up to four at a time");
  assert.equal(progress.at(-1), 35);
});

test("an interrupted upload sends only the pieces the server does not hold", async () => {
  const server = fakeServer({ held: [0, 2] });
  await uploadFile(file(35), { api: server.api, resumeId: "job-1" });
  assert.deepEqual(server.calls.pieces.sort(), [1, 3]);
});

test("a piece that fails on the way is sent again; a refusal that sending again cannot fix is not", async () => {
  const flaky = fakeServer({ fail: { 1: 2 } });
  await uploadFile(file(35), { api: flaky.api, backoff: 0 });
  assert.equal(flaky.calls.pieces.filter((n) => n === 1).length, 3);
  const refused = fakeServer({
    fail: {
      0: 9,
      error: new ApiError(403, "forbidden", "Your role cannot import lists."),
    },
  });
  await assert.rejects(uploadFile(file(35), { api: refused.api, backoff: 0 }), /Your role cannot import/);
  assert.equal(refused.calls.pieces.filter((n) => n === 0).length, 1);
  const hopeless = fakeServer({ fail: { 0: 99 } });
  await assert.rejects(uploadFile(file(35), { api: hopeless.api, backoff: 0, retries: 2 }), /cannot be reached/);
  assert.equal(hopeless.calls.pieces.filter((n) => n === 0).length, 3);
});

test("following an import stops where the server waits for the person", async () => {
  const states = ["queued", "loading", "loading", "mapping"];
  const seen = [];
  const job = await follow("job-1", (j) => seen.push(j.status), {
    every: 1,
    get: async (id) => ({ id, status: states.shift() }),
  });
  assert.equal(job.status, "mapping");
  assert.deepEqual(seen, ["queued", "loading", "loading", "mapping"]);
});

const columns = [
  {
    idx: 0,
    header: "Owner Name",
    suggested: "name",
    field: null,
    used: null,
    populated: 10,
    samples: [],
  },
  {
    idx: 1,
    header: "Cell",
    suggested: "phone",
    field: null,
    used: null,
    populated: 9,
    samples: [],
  },
  {
    idx: 2,
    header: "Bathroom style",
    suggested: null,
    field: null,
    used: null,
    populated: 5,
    samples: [],
  },
];

test("the columns are answered with the suggestions unless the person chose otherwise", () => {
  assert.deepEqual(mappingBody(columns, {}).columns, [
    { idx: 0, field: "name", use: true },
    { idx: 1, field: "phone", use: true },
    { idx: 2, use: false },
  ]);
  assert.deepEqual(mappingBody(columns, { 2: "city", 1: null }).columns, [
    { idx: 0, field: "name", use: true },
    { idx: 1, use: false },
    { idx: 2, field: "city", use: true },
  ]);
});

test("property and mailing fields from supplied lists can be confirmed as structured source data", () => {
  const available = new Set(SOURCE_IMPORT_FIELDS.map(([key]) => key));
  for (const key of ["county", "living_area", "year_built", "lot_size_acres", "lot_size_square_feet", "bedrooms", "bathrooms", "stories", "garage_area", "owner_2_first_name", "owner_mailing_address", "owner_mailing_zip", "ownership_length", "vacancy", "status_time"]) {
    assert.ok(available.has(key), key);
  }
  const sourceColumns = [
    { idx: 0, suggested: "first_name" }, { idx: 1, suggested: "address" }, { idx: 3, suggested: "phone" },
    { idx: 2, suggested: null, source_detail: "Living area", standard_key: "living_area" },
  ];
  assert.deepEqual(mappingBody(sourceColumns, {}).columns.find((column) => column.idx === 2), { idx: 2, field: "living_area", use: true });
  assert.equal(mappingProblem(sourceColumns, {}), "");
});

test("the person is told what is missing before anything is sent", () => {
  assert.equal(mappingProblem(columns, {}), "");
  assert.match(mappingProblem(columns, { 0: null }), /name column/);
  assert.match(mappingProblem(columns, { 1: null }), /phone or an email column/);
  assert.match(mappingProblem(columns, { 2: "name" }), /Two columns are set to Name/);
  assert.equal(mappingProblem(columns, { 2: "phone" }), "", "phone and email may come from several columns");
  // A list for skip tracing may have addresses and no phone or email.
  const addresses = [{ idx: 0, suggested: "name" }, { idx: 1, suggested: "address" }];
  assert.equal(mappingProblem(addresses, {}, true), "");
  assert.match(mappingProblem(addresses, {}, false), /phone or an email column/);
  assert.match(mappingProblem(addresses, { 1: null }, true), /needs an address column/);
});
