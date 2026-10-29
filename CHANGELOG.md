# Changelog

## 0.2.0 - 2026-10-29 (unpublished)

- Remove the prior FAR-times-lot-area-minus-gross-building-area calculation for
  every parcel. Recorded MapPLUTO FAR, area and district facts remain available;
  they do not establish parcel capacity, unused development rights or compliance.
- Retain deprecated `unused_floor_area.estimate_sqft`, `allowed_floor_area_sqft`,
  `governing_far` and `overbuilt` keys as null, with basis
  `not determined from recorded parcel data` and explicit limitations. The tool
  output schema now declares these keys null; consumers must accept null.
- Remove calculated capacity and compliance inferences from lot prose, tool
  descriptions, server instructions and package/registry descriptions.
- Label the public map link `Public lot map`; preserve `full_report_url` as a
  documented legacy field name that does not provide paid report data.
- Identify district output as scraped NYRezone HTML summaries, without claiming
  direct verification against the NYC Zoning Resolution.
- Identify release labels and check stamps as site-reported, not independently
  validated for each result; use unknown when the release stamp is missing or
  unavailable. Align package, lockfile, runtime and registry manifest at 0.2.0.
- Expand existing fixture and real stdio tests for the former 16,094 sq ft example,
  the formerly flagged Empire State Building, false split flags with multiple
  districts, unknown source labels, null compatibility and owner-field exclusion.
- Update existing exact dependency pins to MCP server/client SDK 2.4.0 and Zod
  4.6.7 to resolve native npm audit advisories affecting the previous pins.
- Reuse the existing SDK, test suite and documentation; no new service, framework,
  schedule or publishing-trust change.

## 2026-10-28 — Documentation accuracy

Clarify that the published 0.1.0 stdio package is separate from the hosted ChatGPT
facts app. Recorded FAR fields, calculated screening outputs and district summaries
parsed from NYRezone are distinguished from parcel-specific legal capacity. The
README now documents the separate residential-estimate/highest-FAR flag behavior,
the legacy `allowed_floor_area_sqft`/`sq ft allowed` wording, split-lot limits and
the public map destination of the `Full report` link. No runtime, version or
dependency changed; these disclosures do not certify capacity or all district rules.

Verification: 39 existing fixture/stdio tests passed. Published npm JavaScript
matches the fresh source build. Three public BBL examples matched selected city
record fields, and the city records' 26v2 version matched the package's methodology
label on October 28. These observations establish neither legal allowance nor
exhaustive API/district correctness.

## 0.1.1 - planned

- Optional packaging: MCPB bundle and Smithery listing (removed from 0.1.0 until they can be built, signed and checksummed for real).

## 0.1.0 - 2026-10-15

Initial build; version 0.1.0 was subsequently published to npm and the official MCP
registry on October 16, 2026.

- Tools: `lookup_lot`, `get_zoning_district`, `list_zoning_districts`.
- Lot data from NYRezone `/api/pluto`; owner name/type and assessed values are dropped before any result is returned.
- Address lookup resolves through NYC Planning Labs Geosearch (NYRezone has no address endpoint) and errors on ambiguous or unknown addresses.
- District rules parsed from the server-rendered nyrezone.com district pages; parsers fail loudly if the page format changes.
- Client: descriptive User-Agent, 1 h cache, serialized requests, 20 req/min cap, 10 s timeout, 2 MB cap.
- Tests: node:test with recorded fixtures, malformed-input cases, and a stdio end-to-end test against a local fixture server.
- Skipped: borough-level underbuilt summary (no public data endpoint).
- Review fixes: borough hint read only from the parsed locality and text after the first comma; governing FAR is the highest of residential/commercial/community-facility, and gross building area is no longer presented as evidence of non-compliance; error and empty 200 bodies rejected; district links filtered against the live index; cache bounded at 500 entries; off-origin redirects rejected; publish workflow pins npm and actions by SHA; server.json gets runtimeHint npx.
