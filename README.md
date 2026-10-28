# nyrezone-mcp

Read-only [MCP](https://modelcontextprotocol.io) server that gives AI assistants recorded NYC lot fields and simplified screening calculations from public [NYRezone](https://nyrezone.com) pages and APIs: zoning districts, MapPLUTO FAR fields, lot and gross building area, a calculated floor-area estimate, and district summaries as published by NYRezone.

This legacy `nyrezone-mcp@0.1.0` package runs over stdio in a compatible local MCP
client. It is separate from NYRezone's hosted ChatGPT facts app. Its calculations
and scraped district summaries are not parcel-specific legal capacity determinations
or a certification that every district rule is current.

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
| `lookup_lot` | `address` (starts with a house number, include the borough) **or** `bbl` (10-digit borough-block-lot) | Recorded zoning district(s), overlays, special districts and FAR fields, lot/gross building area, a screening estimate, year built and land use. Ambiguous or unknown address matches return an error. |
| `get_zoning_district` | `code`, e.g. `R6A`, `C4-2`, `M1-2/R6A` | FAR, height rules and bonuses as NYRezone publishes them, citywide lot counts, average built FAR. Unknown code returns the list of valid codes. |
| `list_zoning_districts` | optional `family`, e.g. `R6` | The 51 districts NYRezone documents, each with its district-family description. |

Every successful result includes a source line and disclaimer. The MapPLUTO release
label is read from NYRezone's methodology page, not independently established by
each lookup. District rules are parsed from NYRezone's pages, not fetched directly
from the Zoning Resolution. The legacy `Full report` link opens the public lot map;
it does not return paid report data.

Not included: a borough-level "underbuilt" summary. NYRezone publishes that only as web pages, not as a data endpoint.

### Example

`lookup_lot` with `bbl: "3052410015"` returns, in part: zoning R7A, lot area 4,675 sq ft, building area 2,606 sq ft, built FAR 0.56 against a 4.0 residential maximum, and an estimated 16,094 sq ft unused.

## How the unused-floor-area estimate works

The headline is `max(0, residential FAR x lot area - gross building area)`, using
MapPLUTO's recorded residential FAR when positive. If no positive residential FAR
is listed, it uses the highest positive commercial/community-facility FAR. The
`overbuilt` flag separately compares gross building area with the highest listed
FAR across all three use categories. A zero headline therefore does not necessarily
set that flag or mean no commercial floor-area difference exists.

This is a screening calculation, not recorded unused development rights. The legacy
field `allowed_floor_area_sqft` and output phrase `sq ft allowed` describe that
simple FAR multiplication, **not legally allowed floor area**. Gross building area
is not zoning floor area; even `overbuilt: true` is not evidence of non-compliance.
No runtime output names or calculations were changed by this documentation update.

The calculation does not account for street width, special districts, overlays,
split-zoned lot geometry, mapped streets or City of Yes / Universal Affordability
Preference bonuses. Split lots still receive a numeric estimate and a warning;
that warning does not validate the estimated capacity. Confirm applicable use,
district boundaries, current rules and zoning floor area with an appropriate
professional before relying on a development-capacity figure.

## Data sources and what leaves your machine

- **nyrezone.com** (`/api/pluto`, `/zoning`, `/zoning/<code>`, `/methodology`): lot data and district pages. Data is NYC DCP MapPLUTO; the release is read from NYRezone's own methodology page.
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
