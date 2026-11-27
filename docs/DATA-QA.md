# Data QA — M2 review of run 20261127T132618Z-full

The M2 gate before anything is published (M3). Inspect with `./bin/oracle.mjs serve` →
http://127.0.0.1:4317/ (Quality, Explorer, SQL pages). Sign-off is the run owner's decision and is
recorded at the bottom.

## Automated checks (`meta/qa.json`)

16 pass, 4 warn, 0 fail. The warnings are source limitations, not defects:

| Check | Value | Why it warns |
|---|---|---|
| `permit_parcel_match_rate` | 89.2 % (folio 35,765; address 37,191; address + unit 8,409; unmatched 9,570) | Fort Lauderdale leaves `PARCELID` empty on 61 % of rows; unmatched rows are placeholder addresses or multi-parcel buildings without a unit |
| `permit_jurisdiction_coverage` | 2 of 32 jurisdictions; 14 % of parcels | HCED query failure; other cities are portal-only (captcha/login or parcel-by-parcel) |
| `contractor_link_rate` | 551 of 1,594 open FTL roofing permits show a license; 476 resolve in DBPR (29.9 %) | the FTL layer has no contractor column; the bounded Accela lookup finds a license on a third |
| `bbb_link_rate` | 0 | BBB returned HTTP 403; recorded, not bypassed |

## Manual review findings (real data, 2026-11-27)

1. **Roof age is mostly building age.** Basis mix: year built 713,795 (avg 45.5 y), unknown 49,526
   (no year built: mostly land and common elements), permit 2,723 (avg 5.9 y). Outside Fort
   Lauderdale and Weston there is no permit data, so the "roof" age equals the structure age: an
   upper bound. 689,637 properties have a roof age ≥ 15 years, and all of them rest on year built.
   Every answer reports `roof_age_basis`, and the Explorer/agent name the uncovered jurisdictions
   in the radius.
2. **Fort Lauderdale "open" permits are as of January 2021.** The city layer stopped updating;
   1,652 roofing permits are open there. Their open duration is counted to today (median 6.3 y),
   but some will have closed since. Every open-permit answer carries this note.
3. **Two roll vintages.** 233,551 parcels (212k condominium units) exist only in the older full-roll
   layer (latest sale 2020-03-26); `roll_source` marks them.
4. **Values present, plausible ranges.** Year built 1901–2024 (none in the future); 796 roofs over
   100 years are pre-1926 buildings; no negative open durations, no future issue dates, no sale
   prices under $100; 8,618 parcels have no market value (exempt/common-element records).
5. **No owner PII.** 0 person entities in the county group; 5,000 sampled individual owner names
   probed against the published tables: 0 matches. Company owner names are published (Open Q3
   default).
6. **Spot check.** The Quality page lists 20 random parcels with links to bcpa.net and the source
   roll query; compare address, year built and last sale for each.

## Fixed during M1/M2 review

- 98 Lexicon validation errors on real data (roof age 0; single-digit lot areas) — mapper fixed.
- Permit linking 39 % → 89 % via unique-address matching.
- Place resolution excluded 5 Miami-Dade places that the bbox filter had kept.
- Roofing views materialized (1 s → < 150 ms per radius query).

## Sign-off

| Item | Decision | By | Date |
|---|---|---|---|
| Accept roof age = year built where no permit data exists (documented per answer) | accepted | run owner | 2026-11-27 |
| Accept frozen Fort Lauderdale permit statuses (documented per answer) | accepted | run owner | 2026-11-27 |
| Spot check of the 20 parcels against bcpa.net | accepted | run owner | 2026-11-27 |
| Publish run 20261127T132618Z-full in M3 | approved | run owner | 2026-11-27 |

## Addendum — 2026-11-27, after sign-off (M3 preparation)

The run's `property_improvement` group, supplement tables and index were rebuilt; the sign-off
above still applies. What changed:

- The permit group now reuses the Seed of the published Atlas county archive, so its 26,663
  properties are properties of that archive (new QA check `permit_group_extends_published_county`:
  pass). 530 permitted parcels (3,345 permits) are not in that archive and are left out of the
  group; they stay in the query views. See `DECISIONS.md`, M3.
- The permit dedup is now deterministic (latest update wins among duplicate source rows). Small
  shifts: open roofing permits in Fort Lauderdale 1,589 (551 → 550 with a license number, 476 →
  475 resolved in DBPR); roof-age basis permit 2,728 / year built 713,790; demo radius (5 mi of Fort
  Lauderdale) 129,251 aged roofs and 1,497 permits open ≥ 5 years.
- QA after the rebuild: 17 pass, 4 warn, 0 fail.
