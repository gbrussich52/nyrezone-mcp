// BBL handling and the mapping from NYRezone's raw /api/pluto row to the small,
// PII-free lot record this server returns. The mapping is an allow-list: any field
// not named here (owner name/type, assessed values, ...) can never reach a tool result.

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Accepts "3052410015", "3-05241-0015", "3/5241/15" style input and a trailing ".0". */
export function parseBbl(input: string): string {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 40) throw new InputError('bbl must be a 10-digit NYC borough-block-lot number, e.g. 3052410015.');
  const dotted = raw.replace(/\.0+$/, '');
  const parts = dotted.split(/[-/\s]+/);
  let digits: string;
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const [b, block, lot] = parts;
    if (b.length !== 1 || block.length > 5 || lot.length > 4) throw new InputError('bbl parts must be borough (1 digit), block (up to 5), lot (up to 4).');
    digits = b + block.padStart(5, '0') + lot.padStart(4, '0');
  } else if (/^\d{10}$/.test(dotted)) {
    digits = dotted;
  } else {
    throw new InputError('bbl must be a 10-digit NYC borough-block-lot number, e.g. 3052410015 (or borough-block-lot like 3-05241-0015).');
  }
  if (!/^[1-5]/.test(digits)) throw new InputError('bbl must start with a borough digit 1-5 (1 Manhattan, 2 Bronx, 3 Brooklyn, 4 Queens, 5 Staten Island).');
  return digits;
}

const BOROUGHS: Record<string, string> = { MN: 'Manhattan', BX: 'Bronx', BK: 'Brooklyn', QN: 'Queens', SI: 'Staten Island' };

export const LAND_USE: Record<string, string> = {
  '01': 'One & Two Family Buildings',
  '02': 'Multi-Family Walk-Up Buildings',
  '03': 'Multi-Family Elevator Buildings',
  '04': 'Mixed Residential & Commercial Buildings',
  '05': 'Commercial & Office Buildings',
  '06': 'Industrial & Manufacturing',
  '07': 'Transportation & Utility',
  '08': 'Public Facilities & Institutions',
  '09': 'Open Space & Outdoor Recreation',
  '10': 'Parking Facilities',
  '11': 'Vacant Land',
};

export interface LotRecord {
  bbl: string;
  address: string | null;
  borough: string | null;
  zip: string | null;
  community_district: string | null;
  zoning_districts: string[];
  commercial_overlays: string[];
  special_districts: string[];
  split_zone: boolean;
  historic_district: string | null;
  landmark: string | null;
  land_use: { code: string; label: string } | null;
  building_class: string | null;
  lot_area_sqft: number | null;
  building_area_sqft: number | null;
  residential_units: number | null;
  total_units: number | null;
  num_floors: number | null;
  year_built: number | null;
  built_far: number | null;
  max_far: { residential: number | null; commercial: number | null; community_facility: number | null };
  unused_floor_area: UnusedFloorArea;
}

export interface UnusedFloorArea {
  /** Deprecated compatibility fields: recorded parcel data does not determine capacity. */
  estimate_sqft: null;
  overbuilt: null;
  allowed_floor_area_sqft: null;
  governing_far: null;
  basis: string;
  caveats: string[];
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function undeterminedFloorArea(): UnusedFloorArea {
  return {
    estimate_sqft: null,
    overbuilt: null,
    allowed_floor_area_sqft: null,
    governing_far: null,
    basis: 'not determined from recorded parcel data',
    caveats: [
      'MapPLUTO building area is gross building area, not zoning floor area.',
      'Recorded FAR fields do not establish an applicable FAR or legally permitted floor area for this parcel.',
      'District boundaries and split-zone geometry, applicable uses, special districts, overlays, bonuses, zoning-lot history and current rules require separate verification.',
      'Unused development rights, development capacity and zoning compliance are not determined by this tool.',
    ],
  };
}

/** Allow-list mapping from the raw API row. Throws InputError-free; callers validate the BBL first. */
export function mapPlutoRow(raw: unknown, bbl: string): LotRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('Unexpected lot data format from upstream.');
  const r = raw as Record<string, unknown>;

  const zoning = ['zonedist1', 'zonedist2', 'zonedist3', 'zonedist4'].map((k) => str(r[k])).filter((v): v is string => v !== null);
  const overlays = ['overlay1', 'overlay2'].map((k) => str(r[k])).filter((v): v is string => v !== null);
  const special = ['spdist1', 'spdist2', 'spdist3'].map((k) => str(r[k])).filter((v): v is string => v !== null);

  const luRaw = str(r.landuse);
  const luCode = luRaw && /^\d{1,2}$/.test(luRaw) ? luRaw.padStart(2, '0') : null;
  const yearBuilt = num(r.yearbuilt);
  const splitZone = r.splitzone === true || r.splitzone === 'true';

  const lotArea = num(r.lotarea);
  const buildingArea = num(r.bldgarea);
  const far = {
    residential: num(r.residfar),
    commercial: num(r.commfar),
    community_facility: num(r.facilfar),
  };
  const farRounded = {
    residential: far.residential === null ? null : round(far.residential, 2),
    commercial: far.commercial === null ? null : round(far.commercial, 2),
    community_facility: far.community_facility === null ? null : round(far.community_facility, 2),
  };
  const builtFar = num(r.builtfar);
  const boroCode = str(r.borough);

  return {
    bbl,
    address: str(r.address),
    borough: boroCode ? (BOROUGHS[boroCode.toUpperCase()] ?? boroCode) : null,
    zip: str(r.zipcode),
    community_district: str(r.cd),
    zoning_districts: zoning,
    commercial_overlays: overlays,
    special_districts: special,
    split_zone: splitZone,
    historic_district: str(r.histdist),
    landmark: str(r.landmark),
    land_use: luCode ? { code: luCode, label: LAND_USE[luCode] ?? 'Unknown land use code' } : null,
    building_class: str(r.bldgclass),
    lot_area_sqft: lotArea,
    building_area_sqft: buildingArea,
    residential_units: num(r.unitsres),
    total_units: num(r.unitstotal),
    num_floors: num(r.numfloors) === null ? null : round(num(r.numfloors)!, 1),
    // MapPLUTO uses 0 for "unknown".
    year_built: yearBuilt && yearBuilt > 0 ? yearBuilt : null,
    built_far: builtFar === null ? null : round(builtFar, 2),
    max_far: farRounded,
    unused_floor_area: undeterminedFloorArea(),
  };
}
