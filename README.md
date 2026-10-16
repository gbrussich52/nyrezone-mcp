# nyrezone-mcp

Read-only [MCP](https://modelcontextprotocol.io) server that gives AI assistants NYC zoning facts from the public data on [NYRezone](https://nyrezone.com): which zoning district a tax lot is in, built vs. allowed FAR, lot and building area, an estimated unused floor area, and the rules for each zoning district.

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
| `lookup_lot` | `address` (starts with a house number, include the borough) **or** `bbl` (10-digit borough-block-lot) | Zoning district(s), overlays and special districts, built FAR vs. maximum FAR, lot area, building area, estimated unused floor area, year built, land use. Ambiguous or unknown input returns an error, never a guess. |
| `get_zoning_district` | `code`, e.g. `R6A`, `C4-2`, `M1-2/R6A` | FAR, height rules and bonuses as NYRezone publishes them, citywide lot counts, average built FAR. Unknown code returns the list of valid codes. |
| `list_zoning_districts` | optional `family`, e.g. `R6` | The 51 districts NYRezone documents, each with its district-family description. |

Every result ends with a source line (MapPLUTO release as stated by NYRezone, the matching nyrezone.com page, and for lots a `Full report` link) and a disclaimer.

Not included: a borough-level "underbuilt" summary. NYRezone publishes that only as web pages, not as a data endpoint.

### Example

`lookup_lot` with `bbl: "3052410015"` returns, in part: zoning R7A, lot area 4,675 sq ft, building area 2,606 sq ft, built FAR 0.56 against a 4.0 residential maximum, and an estimated 16,094 sq ft unused.

## How the unused-floor-area estimate works

`maximum FAR x lot area - existing building area`, using MapPLUTO's residential FAR (commercial or community-facility FAR if there is no residential FAR). It is a screening number only. It does not account for street width, special districts, overlays, split-zoned lots, mapped streets, or City of Yes / Universal Affordability Preference bonuses. If the building already exceeds the maximum, the tool reports 0 and says the lot is over-built.

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
