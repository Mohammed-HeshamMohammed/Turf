# Feature 4: Leads map

**Status:** Agreed (2026-10-25)

## What exists today

The Leads map (Leads → Map, `src/LeadsMap.jsx`), in the manner of a property search map:

- **Price pins.** A dashed pin means only the lead's ZIP area is known, not the exact house.
- **Count bubbles** when zoomed out.
- **Property cards** beside the map for what is in view ("12 in this area"): price, beds, baths, area, address, owner, stage and **Open**.
- **Hovering a card lights its pin**; choosing a pin selects its card.
- **Placing leads:** at once from their ZIP centre (a Census file shipped with Caller Whale, offline). Exact places come from the US Census geocoder **only when the person presses "Find exact locations"**: street, city, state and ZIP only, never names or phones. The result is remembered on the lead.
- **The map** is Leaflet with standard OpenStreetMap tiles. Those public tile servers don't allow heavy commercial use, so the map background must move to another source before launch.

## What the customer gets

| Part | What it does |
| --- | --- |
| **Leads map** | Price pins, count bubbles, property cards and hover/click linking (as today) |
| **Exact locations** | Leads move from the ZIP centre to the real house |
| **Snap to the building** | The pin sits on the actual roof, using open building outlines |
| **Nearest address / building** | Click anywhere and get the closest address and building |
| **Leads near this one** | "Show my leads within 0.5 miles", street by street; feeds the dialer (Feature 3) |
| **See the house** | A button opens Google Street View for the address in Google Maps' own tab or app |
| **Offline map** (desktop) | Download a county or state and the map works with no internet |

### Why Google is only a link

Google has the most accurate house-level locations, plus Street View and satellite. Its terms clash with how Caller Whale works:

- Google's locations may be kept for **only 30 days**, and may not be shown on a non-Google map. Caller Whale keeps exact spots on the lead for good and works offline.
- Street View content may not be used in an app that contains a non-Google map. For projects created or changed after July 2025 with an EEA billing account, it may not be shown with **any** map.
- After the free amount, map loads cost $7 per 1,000 (10,000 free a month) and locations $5 per 1,000 (10,000 free).

A plain link that opens Google Maps at the address needs no key, costs nothing, and keeps Caller Whale inside the rules.

## Where it runs

| Device | Map | Exact locations / nearest | Offline map |
| --- | --- | --- | --- |
| Windows 10/11, Mac (desktop app) | ✅ | Server; results kept on the lead | ✅ county or state download |
| Web app, any computer | ✅ | Server | ❌ |
| Old PC, Windows 7/8 (Firefox 115 ESR) | ✅ (Leaflet is light) | Server | ❌ |
| Phone | ✅ simplified: list first, map on tap | Server | ❌ (native app later) |

## Where the data lives

| Data | Server | Device |
| --- | --- | --- |
| Map background (tiles) | OpenFreeMap now; Caller Whale's own tile file later | Cached; desktop offline download |
| **Exact locations** | ✅ **one global cache, address → spot, kept for good.** Addresses are public, so one lookup serves every customer. | ✅ on their leads |
| Building outlines (for snapping) | ✅ for the states customers use | ❌ |
| Nearest / nearby search | ✅ PostGIS | Desktop: the local database |
| ZIP centres | ✅ | ✅ shipped with Caller Whale (as today) |

## What it costs Caller Whale

| Item | Option | Cost |
| --- | --- | --- |
| **Map tiles** | **OpenFreeMap** now: free, no keys, no view limits, donation-funded, no guarantee it stays up | $0 |
| | **Caller Whale's own tile file (Protomaps)** on the VPS later: served by Caller Whale, offline-ready | ~$0 + disk (a state is small; all of the US is tens of GB) |
| | **Stadia Maps** as a paid backup | $20 / month (1M credits), $80 / month (7.5M) |
| **Exact locations + reverse lookups** | **Geocodio**: results may be kept for good | **2,500 free a day** (~75,000 a month), then **~$1 per 1,000** |
| | US Census geocoder fallback | $0 |
| Building outlines | Microsoft US Building Footprints / Overture Maps (open data) | $0 + a few GB of disk |
| Nearest / nearby search | PostGIS | $0 |
| Street View | Link to Google Maps | $0 |

**Exact locations are the only real cost**, about $0.001 per address. The global cache (an address looked up once is free for every customer afterwards) and Geocodio's free 2,500 a day make it smaller still; early customers are covered entirely.

## Competition

| Tool | Map features | Price |
| --- | --- | --- |
| DealMachine | Map, driving for dollars, route planning to properties, street imagery | ~$49–99 / month (annual) |
| PropStream | Map search, comps, driving for dollars | $99 / $199 |
| BatchLeads | Map search on its own data | ~$119 / month |
| REsimpli | Lead map | Part of $199+ |
| Zillow / Redfin (consumer) | The look Caller Whale's map follows; not a CRM | Free |
| Google Maps Platform (to build your own) | Best data; 30-day storage limit, Google-map-only rules | Map loads $7 per 1,000 after 10,000 free |

**Where Caller Whale wins:** the customer's own leads on a property-search-style map, cleaned by Features 1–2, with stage, owner and Skip Tracing results on each card; "leads near this one" for calling a street with the dialer (Feature 3); snapping to the actual building with free open data; offline maps on the desktop; included rather than sold as a separate data subscription.

**Where they win:** comps and sale prices (PropStream), which need the supplier's data (Feature 1b); driving for dollars with route planning on a phone (DealMachine), a good future feature for Caller Whale's mobile app; their maps show every property in an area, while Caller Whale's shows the customer's leads.

Sources: [Google Street View Static API policies](https://developer.google.com/maps/documentation/streetview/policies) · [Street View changes for EEA customers](https://developers.google.com/maps/comms/eea/street-view-static?authuser=6) · [Street View with non-Google maps (VertiGIS forum)](https://support.vertigis.com/hc/fr/community/posts/11498837309330-Is-Google-Street-View-allowed) · [Google Maps Platform service terms](https://cloud.google.com/archive/maps-platform/terms/maps-service-terms-20250501) · [Google Maps pricing 2026 (MapAtlas)](https://mapatlas.eu/blog/google-maps-api-pricing-2026) · [Google Maps API pricing (StoreRocket)](https://storerocket.io/learn/google-maps-api-pricing) · [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/) · [OpenFreeMap](https://openfreemap.org) · [Stadia Maps pricing](https://tiles.stadiamaps.com/pricing) · [Geocodio pricing](https://geocod.io/pricing) · [Geocodio 2026 pricing update](https://www.geocod.io/updates/pricing-updates-2026) · [PMTiles with MapLibre](https://docs.protomaps.com/pmtiles/maplibre) · [PropStream vs DealMachine 2026](https://goliathdata.com/propstream-vs-dealmachine-an-investor-s-guide-for-2026) · [DealMachine vs PropStream](https://dealmachine.com/blog/dealmachine-vs-propstream-what-is-the-difference) · [PropStream pricing](https://www.propstream.com/news/how-much-does-propstream-cost) · [BatchLeads pricing](https://resimpli.com/blog/batchleads-pricing/)

## Amounts, cost and selling price

This prices **the feature**, not the plans. The tier names are labels only.

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Leads map, nearby search, building snap, Street View link | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Exact locations + reverse lookups per month** | 500 | 5,000 | 10,000 shared | 5,000 per seat, shared | 15,000 per seat, shared |
| **Offline maps** (desktop) | ❌ | 1 state | 2 states | 1 state per seat | All of the US |
| **Cost to Caller Whale, fully used** (no cache, no free tier) | ~$0.50 | ~$5 | ~$10 | ~$5 per seat | ~$15 per seat |
| **Cost to Caller Whale, typical** (cache + free tier) | ~$0 | ~$0.50–1 | ~$1–2 | ~$0.50–1 per seat | ~$1.50–3 per seat |
| **Selling price of this feature** | Free | **$19 / month** | **$29 / month** for both | **$15 per seat / month** | **$29 per seat / month** |
| **Margin, fully used** | — | ~74% | ~66% | ~67% | ~48% |
| **Margin, typical** | — | ~95% | ~95% | ~95% | ~90% |

**Extra exact locations:** +10,000 for **$15**. Cost to Caller Whale: up to ~$10, usually much less thanks to the cache.

**Why these selling prices:** competitors bundle maps into $49–199 data subscriptions. Caller Whale's map is about the customer's own leads, so it is priced as a modest add-on that nobody thinks twice about. Its main value is tying Features 1–3 together: see where the clean leads are, then call a whole street.
