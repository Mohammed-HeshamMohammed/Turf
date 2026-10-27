"""Builds turf_service/data/zip_centres.csv from two public US Census Bureau files.

    python tools/build_zip_centres.py <gazetteer.txt> <zcta-to-county.txt>

Sources (public domain, no key needed):
  - ZIP Code Tabulation Area gazetteer, one centre point per ZIP:
    https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
  - ZCTA to county relationship file, which tells which state or states a ZIP lies in:
    https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt

Each output line is: zip,latitude,longitude,states  (states joined by "|" where a ZIP crosses a state line).
Run again when the Census Bureau publishes new files; nothing else in Turf needs to change.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

# State FIPS codes, the first two digits of a county code.
STATES = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
}


def main(gazetteer: Path, relationship: Path) -> None:
    states: dict[str, set[str]] = {}
    with relationship.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle, delimiter="|"):
            zip_code, county = row["GEOID_ZCTA5_20"], row["GEOID_COUNTY_20"]
            if zip_code and county[:2] in STATES:
                states.setdefault(zip_code, set()).add(STATES[county[:2]])

    lines = []
    with gazetteer.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = [name.strip() for name in next(reader)]
        zip_at, lat_at, lon_at = header.index("GEOID"), header.index("INTPTLAT"), header.index("INTPTLONG")
        for row in reader:
            zip_code = row[zip_at].strip()
            if zip_code not in states:
                continue  # a centre with no known state cannot be checked against a row's state, so it is not used
            lines.append(f"{zip_code},{float(row[lat_at]):.5f},{float(row[lon_at]):.5f},{'|'.join(sorted(states[zip_code]))}")

    output = Path(__file__).resolve().parents[1] / "turf_service" / "data" / "zip_centres.csv"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(lines)} ZIP codes written to {output}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
