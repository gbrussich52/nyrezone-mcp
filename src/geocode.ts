// Address -> BBL via NYC Planning Labs Geosearch (public, no key). NYRezone exposes no
// address endpoint of its own; its browser search uses this same service. We never guess:
// anything other than exactly one distinct BBL for the same house number and street is an error.

import { HttpClient, UpstreamError } from './client.js';
import { InputError } from './lot.js';

export interface Candidate {
  label: string;
  bbl: string;
}

export class AmbiguousAddressError extends Error {
  constructor(public readonly candidates: Candidate[]) {
    super('Address matches more than one tax lot.');
    this.name = 'AmbiguousAddressError';
  }
}

export class AddressNotFoundError extends Error {
  constructor() {
    super('No tax lot found for that address.');
    this.name = 'AddressNotFoundError';
  }
}

const SUFFIX: Record<string, string> = {
  AVENUE: 'AVE', AV: 'AVE', STREET: 'ST', BOULEVARD: 'BLVD', ROAD: 'RD', DRIVE: 'DR', PLACE: 'PL', LANE: 'LN',
  COURT: 'CT', PARKWAY: 'PKWY', TERRACE: 'TER', EAST: 'E', WEST: 'W', NORTH: 'N', SOUTH: 'S',
};

export function normalizeStreet(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const ord = t.match(/^(\d+)(ST|ND|RD|TH)$/);
      return ord ? ord[1] : (SUFFIX[t] ?? t);
    })
    .join(' ');
}

const BOROUGH_WORDS: Record<string, string> = {
  MANHATTAN: 'Manhattan',BROOKLYN: 'Brooklyn', BRONX: 'Bronx', 'THE BRONX': 'Bronx',
  QUEENS: 'Queens', 'STATEN ISLAND': 'Staten Island',
};

const CTRL = /[\u0000-\u001f\u007f]/;

/** Validates raw address input. Everything later is URL-encoded, so this is about clear errors, not safety. */
export function validateAddress(input: string): string {
  const a = input.replace(/\s+/g, ' ').trim();
  if (a.length === 0) throw new InputError('address is empty. Provide a street address with a house number, e.g. "1187 Ocean Ave, Brooklyn".');
  if (a.length < 5 || a.length > 150) throw new InputError('address must be between 5 and 150 characters.');
  if (CTRL.test(a)) throw new InputError('address contains control characters.');
  if (!/^\d+[A-Za-z]?(-\d+)?\s+\S/.test(a)) {
    throw new InputError('address must start with a house number followed by a street name, e.g. "1187 Ocean Ave, Brooklyn". For a block/lot, pass bbl instead.');
  }
  return a;
}

interface GeoFeature {
  properties?: {
    housenumber?: string;
    street?: string;
    label?: string;
    borough?: string;
    addendum?: { pad?: { bbl?: string } };
  };
}

interface GeoResponse {
  features?: GeoFeature[];
  geocoding?: { query?: { parsed_text?: { housenumber?: string; street?: string; locality?: string; admin?: string } } };
}

export async function resolveAddress(client: HttpClient, rawAddress: string): Promise<Candidate> {
  const address = validateAddress(rawAddress);
  const url = `${client.geosearchBase}/v2/search?text=${encodeURIComponent(address)}&size=10`;
  const res = await client.getText(url, 'application/json');
  if (res.status !== 200) throw new UpstreamError('http', `Address search returned HTTP ${res.status}.`, res.status);
  let data: GeoResponse;
  try {
    data = JSON.parse(res.body) as GeoResponse;
  } catch {
    throw new UpstreamError('parse', 'Address search returned an unreadable response.');
  }
  const features = Array.isArray(data.features) ? data.features : [];
  const parsed = data.geocoding?.query?.parsed_text ?? {};

  const fallback = address.match(/^(\S+)\s+([^,]+)/);
  const house = (parsed.housenumber ?? fallback?.[1] ?? '').toUpperCase();
  const street = normalizeStreet(parsed.street ?? fallback?.[2] ?? '');
  if (!house || !street) throw new AddressNotFoundError();

  // Optional borough hint from the text the user typed.
  const hintText = `${parsed.locality ?? ''} ${parsed.admin ?? ''} ${address}`.toUpperCase();
  let boroughHint: string | null = null;
  for (const [word, name] of Object.entries(BOROUGH_WORDS)) {
    if (new RegExp(`(^|[^A-Z])${word}([^A-Z]|$)`).test(hintText)) {
      boroughHint = name;
      break;
    }
  }

  const byBbl = new Map<string, Candidate>();
  for (const f of features) {
    const p = f.properties;
    const bbl = p?.addendum?.pad?.bbl;
    if (!p || !bbl || !/^[1-5]\d{9}$/.test(bbl)) continue;
    if ((p.housenumber ?? '').toUpperCase() !== house) continue;
    if (normalizeStreet(p.street ?? '') !== street) continue;
    if (boroughHint && p.borough && p.borough !== boroughHint) continue;
    if (!byBbl.has(bbl)) byBbl.set(bbl, { label: p.label ?? `${p.housenumber} ${p.street}`, bbl });
  }

  const found = [...byBbl.values()];
  if (found.length === 0) throw new AddressNotFoundError();
  if (found.length > 1) throw new AmbiguousAddressError(found.slice(0, 5));
  return found[0];
}
