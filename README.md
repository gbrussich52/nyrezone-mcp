# nyrezone-mcp

Read-only [MCP](https://modelcontextprotocol.io) server that gives AI assistants recorded NYC lot fields from public [NYRezone](https://nyrezone.com) pages and APIs: zoning districts, MapPLUTO FAR fields, lot and gross building area, and district summaries as published by NYRezone.

The legacy stdio package is separate from NYRezone's hosted ChatGPT facts app.
Version 0.2.0 removes the previous floor-area calculations. Recorded parcel data
and scraped district summaries do not determine parcel-specific legal capacity,
unused development rights or zoning compliance, or certify that every district
rule is current.

It exposes only data that is already public and unauthenticated. No owner names, no assessed values, no paid report data, no account access.

## Install

Requires Node 20+.

```bash
npx -y nyrezone-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nyrezone": { "command": "npx", "args": ["-y", "nyrezone-mcp"] }
  }
}
```

### Claude Code

```bash
claude mcp add nyrezone -- npx -y nyrezone-mcp
```

## Tools

All tools are read-only (`readOnlyHint: true`).

| Tool | Input | Returns |
|---|---|---|
| `lookup_lot` | `address` (starts with a house number, include the borough) **or** `bbl` (10-digit borough-block-lot) | Recorded zoning district(s), overlays, special districts and FAR fields, lot/gross building area, year built and land use. Deprecated capacity calculation fields are retained as null. Ambiguous or unknown address matches return an error. |
| `get_zoning_district` | `code`, e.g. `R6A`, `C4-2`, `M1-2/R6A` | FAR, height rules and bonuses as NYRezone publishes them, citywide lot counts, average built FAR. Unknown code returns the list of valid codes. |
| `list_zoning_districts` | optional `family`, e.g. `R6` | The 51 districts NYRezone documents, each with its district-family description. |

Every successful result includes a source line and disclaimer. The MapPLUTO release
label for lot lookups is reported by NYRezone's methodology page; district lookups
use the label on the district page. Neither is independently validated for the
returned parcel or result. A missing or unavailable release stamp is `unknown`. District rules are parsed from NYRezone's pages, not fetched directly
from the Zoning Resolution. The legacy `Full report` link opens the public lot map;
it does not return paid report data.

Not included: a borough-level "underbuilt" summary. NYRezone publishes that only as web pages, not as a data endpoint.

### Example

`lookup_lot` with `bbl: "3052410015"` returns, in part: recorded zoning R7A,
lot area 4,675 sq ft, gross building area 2,606 sq ft, built FAR 0.56 and a
MapPLUTO residential FAR field of 4.0. It does not calculate capacity from those
fields. Its `unused_floor_area` compatibility object includes:

```json
{
  "estimate_sqft": null,
  "allowed_floor_area_sqft": null,
  "governing_far": null,
  "overbuilt": null,
  "basis": "not determined from recorded parcel data"
}
```

The object also includes `caveats` describing the limits below.

## Capacity is not determined

The previous release multiplied recorded FAR by lot area and subtracted gross
building area. Version 0.2.0 removes that arithmetic for every lot, including
split-zoned lots and records with multiple districts but no split-zone flag.
The four deprecated fields above remain present and always null; their output
schema accepts null. Consumers that assumed a numeric estimate or boolean flag
must handle null.

Gross building area is not zoning floor area. Recorded FAR fields alone do not
establish applicable FAR or legally permitted floor area. District boundaries,
split-zone geometry, applicable uses, special districts, overlays, bonuses,
zoning-lot history and current rules require separate verification. The tool
returns the recorded district and FAR facts without deciding capacity, unused
development rights or compliance.

## Data sources and what leaves your machine

- **nyrezone.com** (`/api/pluto`, `/zoning`, `/zoning/<code>`, `/methodology`): lot data and district pages. The lot endpoint supplies MapPLUTO fields; HTML district summaries are NYRezone's presentation, not direct Zoning Resolution verification. Release labels and check stamps are reported by the site, not independently validated for each returned parcel.
- **NYC Planning Labs Geosearch** (`geosearch.planninglabs.nyc`): used only to turn a street address into a BBL, because NYRezone has no address endpoint. This is the one third-party host; the address you ask about is sent to it. BBL lookups and district lookups never contact it.

The owner name and owner type that NYRezone's lot API returns are dropped in this server and never appear in a tool result.

## Limits and politeness

- Descriptive `User-Agent` (`nyrezone-mcp/<version> (+repo URL)`).
- Requests are serialized, at least 1 second apart, capped at 20 upstream requests per minute, with a 10 second timeout and a 2 MB response cap.
- Responses are cached in memory for 1 hour (not persisted).
- Input is validated before any request: addresses 5-150 characters starting with a house number; BBLs must be 10 digits starting 1-5. Everything sent upstream is URL-encoded.

## Disclaimer

Informational only. Not legal, architectural, or zoning-compliance advice. Confirm with the NYC Department of City Planning or a licensed professional before relying on it. Not affiliated with the City of New York.

## Development

```bash
npm install
npm test        # builds, then runs node:test against recorded fixtures (no live network)
```

Fixtures in `fixtures/` are recorded public responses; the lot fixtures keep the raw owner fields on purpose so the tests prove they are dropped. Environment variables `NYREZONE_MCP_BASE_URL`, `NYREZONE_MCP_GEOSEARCH_URL` and `NYREZONE_MCP_MIN_INTERVAL_MS` exist for the end-to-end test only.

## License

MIT. See [LICENSE](LICENSE).
