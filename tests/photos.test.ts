import { describe, expect, it } from "vitest";
import { photoColumns, photoIndex, photosFor, photosIn, placeColumns, placeKeys, streetKey } from "../src/lib/photos";
import type { DatasetRow } from "../src/lib/types";

const row = (id: number, raw: Record<string, string>) => ({ id: String(id), row_number: id, raw }) as unknown as DatasetRow;
const ZILLOW = "https://photos.zillowstatic.com/fp/1ef025d5a149a2c96cc7e6284114a945-p_e.jpg";

describe("pictures wherever a list keeps them", () => {
  it("finds links, lists of links, img tags, IMAGE formulas and saved pictures, and nothing unsafe", () => {
    expect(photosIn(ZILLOW)).toEqual([ZILLOW]);
    expect(photosIn(`${ZILLOW}\nhttps://example.com/b.png`)).toEqual([ZILLOW, "https://example.com/b.png"]);
    expect(photosIn("https://example.com/a.JPG?w=600, https://example.com/b.webp | https://example.com/c.jpeg")).toHaveLength(3);
    expect(photosIn('<img src="https://example.com/house.jpg" alt="">')).toEqual(["https://example.com/house.jpg"]);
    expect(photosIn('=IMAGE("https://example.com/house.png")')).toEqual(["https://example.com/house.png"]);
    expect(photosIn(`turf-image:${"a".repeat(32)}.png`)).toEqual([`turf-image:${"a".repeat(32)}.png`]);
    expect(photosIn("https://www.zillow.com/homedetails/2505-Hazard-St/2080432917_zpid/")).toEqual([]);
    expect(photosIn("javascript:alert(1).jpg")).toEqual([]);
    expect(photosIn("")).toEqual([]);
  });

  it("knows a picture column by what is in it, cover photo first", () => {
    const rows = [1, 2, 3].map(id => row(id, { Image: ZILLOW, "All photos": `${ZILLOW}\nhttps://example.com/${id}.jpg`, "Detail URL": "https://www.zillow.com/homedetails/x/1_zpid/", Street: `${id} Main St` }));
    expect(photoColumns(rows, ["Image", "All photos", "Detail URL", "Street"])).toEqual(["Image", "All photos"]);
  });
});

describe("the same property in another list", () => {
  it("spells an address one way", () => {
    expect(streetKey("2505 Hazard Street, Unit B")).toBe(streetKey("2505 hazard st unit b"));
    expect(streetKey("12 N. Main Avenue")).toBe("12 n main ave");
  });

  it("borrows the photos of a listing for a lead at the same address or position", () => {
    const listing = row(1, { Street: "2505 Hazard St Unit B", Zip: "77019", Latitude: "29.743519", Longitude: "-95.40684", Image: ZILLOW });
    const listColumns = ["Street", "Zip", "Latitude", "Longitude", "Image"];
    const index = photoIndex([{ rows: [listing], columns: listColumns }]);
    const lead = row(7, { Address: "2505 Hazard Street, Unit B", Zip: "77019-1234" });
    const place = placeColumns(["Address", "Zip"]);
    expect(placeKeys(lead, place)).toContain("a:2505 hazard st unit b|77019");
    expect(photosFor(lead, [], place, index)).toEqual({ photos: [ZILLOW], borrowed: true });
    const elsewhere = row(8, { Address: "9 Other Rd", Zip: "77019" });
    expect(photosFor(elsewhere, [], place, index, [29.74352, -95.40684])).toEqual({ photos: [ZILLOW], borrowed: true });
    expect(photosFor(elsewhere, [], place, index).photos).toEqual([]);
  });
});
