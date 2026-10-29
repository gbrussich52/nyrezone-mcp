import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { HttpClient, VERSION, type ClientOptions } from './client.js';
import { getDistrict, listDistricts, lookupLot, type Outcome } from './service.js';

const INSTRUCTIONS = [
  'Read-only access to public NYC zoning data via NYRezone (nyrezone.com), which is built on NYC MapPLUTO.',
  'Tools: lookup_lot (a tax lot by address or 10-digit BBL), get_zoning_district (NYRezone HTML summary for one zoning code), list_zoning_districts.',
  'Report only what the tools return and always keep the source line and disclaimer with it.',
  'Recorded FAR and gross building area do not determine development capacity, unused development rights or zoning compliance. Deprecated unused_floor_area calculation fields are always null.',
  'If a tool reports an ambiguous or unknown input, ask the user to clarify rather than guessing.',
].join(' ');

// openWorldHint is true because every call reaches out to public web services.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function respond<T extends object>(o: Outcome<T>) {
  if (!o.ok) return { isError: true, content: [{ type: 'text' as const, text: o.error }] };
  return { content: [{ type: 'text' as const, text: o.text }], structuredContent: o.data as Record<string, unknown> };
}

const lotSchema = z.object({
  bbl: z.string(),
  address: z.string().nullable(),
  borough: z.string().nullable(),
  zip: z.string().nullable(),
  community_district: z.string().nullable(),
  zoning_districts: z.array(z.string()),
  commercial_overlays: z.array(z.string()),
  special_districts: z.array(z.string()),
  split_zone: z.boolean(),
  historic_district: z.string().nullable(),
  landmark: z.string().nullable(),
  land_use: z.object({ code: z.string(), label: z.string() }).nullable(),
  building_class: z.string().nullable(),
  lot_area_sqft: z.number().nullable(),
  building_area_sqft: z.number().nullable(),
  residential_units: z.number().nullable(),
  total_units: z.number().nullable(),
  num_floors: z.number().nullable(),
  year_built: z.number().nullable(),
  built_far: z.number().nullable(),
  max_far: z.object({ residential: z.number().nullable(), commercial: z.number().nullable(), community_facility: z.number().nullable() }),
  unused_floor_area: z.object({
    estimate_sqft: z.null().describe('Deprecated; capacity is not determined from recorded parcel data.'),
    overbuilt: z.null().describe('Deprecated; zoning compliance is not determined from gross building area.'),
    allowed_floor_area_sqft: z.null().describe('Deprecated; legally permitted floor area is not determined.'),
    governing_far: z.null().describe('Deprecated; applicable FAR is not determined.'),
    basis: z.string(),
    caveats: z.array(z.string()),
  }),
});

export function createServer(clientOptions: ClientOptions = {}): McpServer {
  const client = new HttpClient(clientOptions);
  const server = new McpServer(
    { name: 'nyrezone-mcp', version: VERSION, title: 'NYRezone - NYC zoning lookups' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'lookup_lot',
    {
      title: 'Look up an NYC tax lot',
      description:
        'Look up one NYC tax lot by street address OR 10-digit BBL (borough-block-lot). Returns recorded zoning district(s), MapPLUTO FAR fields, lot and gross building area, year built and land use via NYRezone. Does not determine development capacity, unused development rights, applicable FAR or zoning compliance; deprecated calculation fields are null. Provide exactly one of address or bbl. Addresses must start with a house number and should include the borough; an ambiguous or unknown address returns an error instead of a guess. Owner and assessment data are never returned.',
      inputSchema: z.object({
        address: z.string().optional().describe('Street address starting with a house number, e.g. "1187 Ocean Ave, Brooklyn".'),
        bbl: z.string().optional().describe('10-digit BBL, e.g. 3052410015 (1 Manhattan, 2 Bronx, 3 Brooklyn, 4 Queens, 5 Staten Island).'),
      }),
      outputSchema: z.object({
        lot: lotSchema,
        resolved_from: z.enum(['bbl', 'address']),
        matched_address: z.string().nullable(),
        full_report_url: z.string(),
        district_pages: z.array(z.string()),
        source: z.string(),
      }),
      annotations: { title: 'Look up an NYC tax lot', ...READ_ONLY },
    },
    async (args) => respond(await lookupLot(client, args)),
  );

  server.registerTool(
    'get_zoning_district',
    {
      title: 'Get an NYC zoning district',
      description:
        'Get the HTML district summary NYRezone publishes for one NYC zoning district code (e.g. R6A, C4-2, M1-2/R6A): max FAR, base and maximum height, bonuses, citywide lot counts and average built FAR. Values are scraped NYRezone summaries, not independently verified against the Zoning Resolution or applied to a parcel. An unknown code returns the list of valid codes.',
      inputSchema: z.object({ code: z.string().describe('Zoning district code such as R6A, R7-2, C4-2 or M1-2/R6A (case-insensitive).') }),
      outputSchema: z.object({
        code: z.string(),
        summary: z.string(),
        rules: z.array(z.object({ rule: z.string(), value: z.string(), note: z.string() })),
        rules_note: z.string().nullable(),
        stats: z.record(z.string(), z.string()),
        boroughs: z.array(z.object({ borough: z.string(), parcels: z.string() })),
        dataVintage: z.string().nullable(),
        dataCheckedOn: z.string().nullable(),
        url: z.string(),
        source: z.string(),
      }),
      annotations: { title: 'Get an NYC zoning district', ...READ_ONLY },
    },
    async ({ code }) => respond(await getDistrict(client, code)),
  );

  server.registerTool(
    'list_zoning_districts',
    {
      title: 'List NYC zoning districts',
      description:
        'List the NYC zoning district codes NYRezone documents, each with a one-line summary (its district family description). Optionally filter by family, e.g. R6 or C4.',
      inputSchema: z.object({ family: z.string().optional().describe('Optional family filter such as R6, C4, M1.') }),
      outputSchema: z.object({
        count: z.number(),
        districts: z.array(z.object({ code: z.string(), family: z.string(), summary: z.string(), url: z.string() })),
        source: z.string(),
      }),
      annotations: { title: 'List NYC zoning districts', ...READ_ONLY },
    },
    async ({ family }) => respond(await listDistricts(client, family)),
  );

  return server;
}
