# Lexicon map — Broward Oracle

Verified against the live Lexicon manifest `https://lexicon.elephant.xyz/api/manifest` on
2026-11-27 (159 entries; schemas fetched by CID from `ipfs.filebase.io`). Every published entity
carries `source_http_request` + `request_identifier`; relationships carry only `from`/`to`.

## Data groups used

| Data group | Schema CID | Built from |
|---|---|---|
| Seed (rides inside every archive) | `bafkreibhurphpjdq33ysit57jtzmdldgngepsdbsw4vm7esawth2ezgaxu` | `address.json` → `parcel.json` (`address_has_parcel`) |
| County | `bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq` | BCPA tax roll (both layers), roof age, company owners |
| Property Improvement | `bafkreicyzywzwhmguojpi2otgrwsyi37le3u4lnavljbxu76cnrudxaxfu` | Fort Lauderdale + Weston permits, DBPR contractors |

There is **no corporate data group** in the live manifest (the only business group is
`Business Location`, which requires a geometry per business). Business records therefore appear
as `company` entities inside the County group (property owners) and the Property Improvement
group (contractors). The Overture places group was a scope cut (architecture §6.1).

## README data need → Lexicon class and fields

| README need | Group | Class (file) | Fields written | Relationship key |
|---|---|---|---|---|
| Parcel identity | Seed | `parcel` (`parcel.json`) | `parcel_identifier` (= BCPA folio, 12 chars `[0-9A-Z]`) | `address_has_parcel` (Seed) / `property_has_parcel` (County) |
| Situs address | Seed + County | `address` (`address.json`, unnormalized branch) | `unnormalized_address`, `county_name: "Broward"` | `property_has_address` |
| Property record | County, PI | `property` (`property.json`) | `parcel_identifier`, `property_type`, `property_usage_type`, `property_legal_description_text`, `property_structure_built_year`, `property_effective_built_year`, `livable_floor_area`, `total_area`, `number_of_units` | — |
| Coordinates | County | `geometry` (`geometry.json`) | `latitude`, `longitude` (parcel centroid, EPSG:4326) | `address_has_geometry` |
| Roof age | County | `structure` (`structure.json`) | `roof_date` (day precision from a permit, year precision from year built), `roof_age_years`; every other required structure field `null` | `property_has_structure` |
| Values / tax | County | `tax` (`tax_2025.json`) | `tax_year`, `property_building_amount`, `property_land_amount`, `property_market_value_amount`, `property_assessed_value_amount`, `property_taxable_value_amount`, `county_/school_/city_taxable_value_amount`, `property_exemption_amount`, `period_start_date`, `period_end_date` | `property_has_tax` |
| Sales / years since transfer | County | `sales_history` (`sales_history_<n>.json`) | `ownership_transfer_date`, `purchase_price_amount` (doc stamps ÷ 0.007), `sale_type: TypicallyMotivated` for qualified sales (codes 01–05) | `property_has_sales_history` |
| Ownership (companies) | County | `company` (`company_owner.json`), `address` (`address_owner_mailing.json`) | `name`, `sunbiz_document_number: null`; mailing `unnormalized_address`, `state_code`, `postal_code` | `sales_history_has_company` (grantee of the latest transfer), `company_has_mailing_address` |
| Permits | PI | `property_improvement` (`property_improvement_<n>.json`) | `permit_number`, `improvement_type`, `improvement_status`, `improvement_action` (roofing), `application_received_date`, `permit_issue_date`, `permit_close_date`, `final_inspection_date`, `completion_date`, `contractor_type` | `property_has_property_improvement` |
| Contractor company | PI | `company` (`company_contractor_<n>.json`) | `name` (DBPR DBA, else licensee), `sunbiz_document_number: null` | `property_improvement_has_contractor` |
| Contractor qualifier | PI | `person` (`person_qualifier_<n>.json`) | `first_name`, `last_name`, `middle_name` (DBPR licensee), other required fields `null` | `contractor_has_person` |

`request_identifier`: the folio for roll entities, the permit key
(`<source_system>:<CASEKEY|PermitNo>`) for permits, the DBPR license id for contractors.

## Lexicon gaps (kept in derived tables, never in the groups)

| Data | Why it is a gap | Where it lives |
|---|---|---|
| Permit description, raw status, permit type text | `property_improvement` has `additionalProperties: false` and no description field | `supplement/permit_details.parquet` → `v_roof_permit` |
| Contractor license number, class, status, expiry | No `license` class and no `contractor_has_license` edge in the live manifest (kit `dbpr-license-ingest`: record the gap, do not substitute) | `supplement/contractors.parquet` → `v_contractor` |
| BBB rating / accreditation | No rating fields in the Lexicon; source blocked this run (HTTP 403) | `bbb_rating`, `bbb_accredited` columns (null) |
| Homestead exemption, DOR land-use code | No home on `property`/`tax` for the flag; `tax_exemption` would need a jurisdiction graph | `supplement/property_signals.parquet` (`homestead`, `land_use_code`) |
| Occupancy class, owner-location class, owner type | Derived classifier outputs (architecture §3.2) | `supplement/property_signals.parquet` → `v_property`, `v_owner` |
| Roof-age lineage (basis, confidence, selected permit, policy) | `structure` has `additionalProperties: false`, so the kit's `source_payload.roof_age_lineage` cannot be written | `supplement/property_signals.parquet` (`roof_age_basis`, `roof_age_confidence`, `roof_age_permit_key`, `roof_age_policy`) |
| Individual owner names, mailing street lines | Open Question 3 default: not published | Work store only |

## Field-format rules the CLI enforces (learned in the Task 0 spike)

- `source_http_request.url` must match `^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/[#a-zA-Z0-9._%-]+)*$`:
  **no query string**. Query parameters go in `multiValueQueryString`
  (`{"where":["FOLIO='…'"],"outFields":["*"],"f":["json"]}`).
- `headers` may carry `content-type` only; GET requests carry no headers at all.
- Property outputs are flat (entity, relationship and root files directly in the property
  ZIP/directory, no `data/` folder).
- An entity referenced by no relationship fails validation (`Unused data JSON file`).
- `parcel_has_property_improvement` allows one link; permits use the array
  `property_has_property_improvement` instead.

## DOR land-use code → property_type (BCPA `USE_CODE`)

`00` VacantLand · `01` SingleFamily · `02` MobileHome · `03` MultiFamilyMoreThan10 · `04` Condominium ·
`05` Cooperative · `06` Retirement · `07` MiscellaneousResidential · `08` MultiFamilyLessThan10 ·
`09` ResidentialCommonElementsAreas · `10`/`40`/`70` VacantLand · other commercial, industrial,
institutional and government codes → `Building` · agricultural and `90–99` → `LandParcel`.
`property_usage_type` follows the DOR code table (`src/classify/land-use.ts`).
Occupancy: residential (`01–09`) + homestead exemption (`HE1_AMOUNT > 0`) → `owner_occupied`;
residential without it → `likely_tenant_occupied`; `00/10/40/70` → `vacant_land`; `11–49` →
`commercial`; government owner or `80–89`/institutional → `government_or_exempt`.
