// Tool logic, free of MCP types so it can be tested directly with a fixture-backed client.
// Each function returns { text, data } on success or { error } for a clear user-facing failure.

import { HttpClient, UpstreamError } from './client.js';
import { AddressNotFoundError, AmbiguousAddressError, resolveAddress } from './geocode.js';
import { InputError, mapPlutoRow, parseBbl, type LotRecord } from './lot.js';
import { ParseError, parseDistrictPage, parseVintage, parseZoningIndex, type DistrictIndexEntry, type DistrictPage } from './parse.js';

export const DISCLAIMER = 'Informational only; not legal, architectural, or zoning-compliance advice. Confirm with NYC Department of City Planning / a licensed professional before relying on it.';
function reportedVintage(release: string | null, checkedOn: string | null): string {
  return `MapPLUTO release reported by NYRezone: ${release ?? 'unknown'}${checkedOn ? ` (site check stamp: ${checkedOn})` : ''}; not independently validated for this result`;
}

export type Outcome<T> = { ok: true; text: string; data: T } | { ok: false; error: string };

const fail = <T>(error: string): Outcome<T> => ({ ok: false, error });

function upstreamMessage(err: unknown): string {
  if (err instanceof UpstreamError) {
    switch (err.kind) {
      case 'timeout': return `The data source timed out. Try again in a moment. (${err.message})`;
      case 'rate_limited': return err.message;
      case 'too_large': return 'The data source returned an unexpectedly large response, so it was rejected.';
      case 'network': return 'Could not reach the data source (nyrezone.com or NYC Geosearch). Check connectivity and try again.';
      case 'parse': return err.message;
      default: return `The data source returned an error. ${err.message}`;
    }
  }
  if (err instanceof ParseError) return `NYRezone's page format looks different than expected, so nothing was returned rather than guessing. (${err.message})`;
  if (err instanceof InputError) return err.message;
  return 'Unexpected error while fetching data.';
}

async function vintage(client: HttpClient): Promise<string> {
  try {
    const res = await client.getText(`${client.nyrezoneBase}/methodology`, 'text/html');
    if (res.status === 200) {
      const v = parseVintage(res.body);
      return reportedVintage(v.release, v.checkedOn);
    }
  } catch {
    // Preserve the lookup, but explicitly report an unknown release when the source is unavailable.
  }
  return reportedVintage(null, null);
}

const districtUrl = (client: HttpClient, slug: string) => `${client.nyrezoneBase}/zoning/${slug}`;

// ---------- districts ----------

export async function loadIndex(client: HttpClient): Promise<DistrictIndexEntry[]> {
  const res = await client.getText(`${client.nyrezoneBase}/zoning`, 'text/html');
  if (res.status !== 200) throw new UpstreamError('http', `NYRezone zoning index returned HTTP ${res.status}.`, res.status);
  return parseZoningIndex(res.body);
}

export interface DistrictList {
  count: number;
  districts: { code: string; family: string; summary: string; url: string }[];
  source: string;
}

export async function listDistricts(client: HttpClient, family?: string): Promise<Outcome<DistrictList>> {
  try {
    let wanted: string | null = null;
    if (family !== undefined && family.trim() !== '') {
      wanted = family.trim().toUpperCase();
      if (!/^[A-Z][0-9]{0,2}$/.test(wanted)) return fail('family must be a district family like R6, C4, or M1.');
    }
    const index = await loadIndex(client);
    const rows = index.filter((d) => wanted === null || d.family.toUpperCase() === wanted);
    if (rows.length === 0) {
      const families = [...new Set(index.map((d) => d.family))].join(', ');
      return fail(`No districts in family "${wanted}". Available families: ${families}.`);
    }
    const districts = rows.map((d) => ({ code: d.code, family: d.family, summary: d.familyLabel, url: districtUrl(client, d.slug) }));
    const source = `Source: NYRezone zoning index, ${client.nyrezoneBase}/zoning. ${DISCLAIMER}`;
    const lines = districts.map((d) => `${d.code} - ${d.summary}`);
    const text = `${districts.length} NYC zoning districts documented on NYRezone${wanted ? ` (family ${wanted})` : ''}. Summaries are the district family description; use get_zoning_district for a code's rules.\n\n${lines.join('\n')}\n\n${source}`;
    return { ok: true, text, data: { count: districts.length, districts, source } };
  } catch (err) {
    return fail(upstreamMessage(err));
  }
}

export function normalizeCodeInput(code: string): string | null {
  const c = code.trim().toUpperCase().replace(/\s+/g, '').replace(/\//g, '-');
  return /^[A-Z][A-Z0-9-]{0,14}$/.test(c) ? c : null;
}

export interface DistrictResult extends DistrictPage {
  url: string;
  rules_note: string | null;
  source: string;
}

export async function getDistrict(client: HttpClient, rawCode: string): Promise<Outcome<DistrictResult>> {
  try {
    const norm = normalizeCodeInput(rawCode);
    const index = await loadIndex(client);
    const valid = () => index.map((d) => d.code).join(', ');
    if (norm === null) return fail(`"${rawCode.slice(0, 40)}" is not a valid district code. Valid codes: ${valid()}.`);
    const entry = index.find((d) => d.slug === norm.toLowerCase());
    if (!entry) return fail(`Unknown zoning district "${norm}". NYRezone documents these ${index.length}: ${valid()}.`);

    const url = districtUrl(client, entry.slug);
    const res = await client.getText(url, 'text/html');
    if (res.status === 404) return fail(`NYRezone has no page for ${entry.code} right now.`);
    const page = parseDistrictPage(res.body);
    const rulesNote = page.rules.length === 0
      ? 'NYRezone publishes parcel statistics but no bulk/height/setback rules table for this district; consult the Zoning Resolution.'
      : null;
    const vint = reportedVintage(page.dataVintage, page.dataCheckedOn);
    const source = `Source: NYRezone HTML district summary, ${url}. ${vint}. Rule values are as published by NYRezone, not independently verified against the NYC Zoning Resolution. ${DISCLAIMER}`;

    const out: string[] = [`${page.code} - ${page.summary}`, ''];
    if (page.rules.length) {
      out.push('Rules (as published by NYRezone):');
      for (const r of page.rules) out.push(`- ${r.rule}: ${r.value}${r.note ? ` - ${r.note}` : ''}`);
    } else {
      out.push(rulesNote!);
    }
    const statKeys = Object.keys(page.stats);
    if (statKeys.length) {
      out.push('', 'Citywide stats: ' + statKeys.map((k) => `${k} ${page.stats[k]}`).join('; '));
    }
    if (page.boroughs.length) out.push('Lots by borough: ' + page.boroughs.map((b) => `${b.borough} ${b.parcels}`).join(', '));
    out.push('', source);
    return { ok: true, text: out.join('\n'), data: { ...page, url, rules_note: rulesNote, source } };
  } catch (err) {
    return fail(upstreamMessage(err));
  }
}

// ---------- lots ----------

export interface LotResult {
  lot: LotRecord;
  resolved_from: 'bbl' | 'address';
  matched_address: string | null;
  full_report_url: string;
  district_pages: string[];
  source: string;
}

export interface LotQuery {
  bbl?: string;
  address?: string;
}

const fmt = (n: number | null, unit = '') => (n === null ? 'unknown' : `${n.toLocaleString('en-US')}${unit}`);

export async function lookupLot(client: HttpClient, q: LotQuery): Promise<Outcome<LotResult>> {
  try {
    const hasBbl = q.bbl !== undefined && q.bbl.trim() !== '';
    const hasAddr = q.address !== undefined && q.address.trim() !== '';
    if (hasBbl === hasAddr) return fail('Provide exactly one of bbl (10-digit borough-block-lot) or address (street address with house number).');

    let bbl: string;
    let matched: string | null = null;
    if (hasBbl) {
      bbl = parseBbl(q.bbl!);
    } else {
      try {
        const c = await resolveAddress(client, q.address!);
        bbl = c.bbl;
        matched = c.label;
      } catch (err) {
        if (err instanceof AmbiguousAddressError) {
          const list = err.candidates.map((c) => `${c.label} (BBL ${c.bbl})`).join('; ');
          return fail(`That address matches more than one tax lot, so no guess was made. Candidates: ${list}. Call again with the bbl you want.`);
        }
        if (err instanceof AddressNotFoundError) {
          return fail('No tax lot found for that address. Include the house number and street, and the borough (e.g. "1187 Ocean Ave, Brooklyn"), or pass a bbl.');
        }
        throw err;
      }
    }

    const res = await client.getText(`${client.nyrezoneBase}/api/pluto?bbl=${encodeURIComponent(bbl)}`, 'application/json');
    if (res.status === 404) return fail(`No MapPLUTO record found for BBL ${bbl}. Check the borough, block and lot numbers.`);
    let raw: unknown;
    try {
      raw = JSON.parse(res.body);
    } catch {
      throw new UpstreamError('parse', 'Lot data came back in an unreadable format.');
    }
    // A 200 with an error body or an empty object must not render as a lot full of "unknown".
    const rr = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const has = (k: string) => rr[k] !== undefined && rr[k] !== null && rr[k] !== '';
    if (rr.error !== undefined || (!has('zonedist1') && !has('lotarea'))) {
      return fail(`The data source returned no usable lot data for BBL ${bbl}.`);
    }
    const lot = mapPlutoRow(raw, bbl);
    const vint = await vintage(client);
    const reportUrl = `${client.nyrezoneBase}/map?bbl=${bbl}`;
    // Only link district pages that exist; the index is a nicety, so its failure must not fail the lot.
    let known: Set<string> | null = null;
    try {
      known = new Set((await loadIndex(client)).map((d) => d.slug));
    } catch {
      known = null;
    }
    const slugs = lot.zoning_districts.map((z) => z.toLowerCase().replace(/\//g, '-')).filter((s) => known === null || known.has(s));
    const pages = slugs.map((s) => districtUrl(client, s));
    const source = `Source: NYRezone /api/pluto parcel records via ${client.nyrezoneBase}. ${vint}. District pages: ${pages.join(', ') || 'n/a'}. Full report: ${reportUrl}. ${DISCLAIMER}`;

    const u = lot.unused_floor_area;
    const lines = [
      `BBL ${lot.bbl}${lot.address ? ` - ${lot.address}` : ''}${lot.borough ? `, ${lot.borough}` : ''}${lot.zip ? ` ${lot.zip}` : ''}`,
      matched ? `Matched from your address to: ${matched}` : '',
      `Zoning: ${lot.zoning_districts.join(' + ') || 'unknown'}${lot.split_zone ? ' (split-zoned lot)' : ''}${lot.commercial_overlays.length ? `; overlay ${lot.commercial_overlays.join(', ')}` : ''}${lot.special_districts.length ? `; special district ${lot.special_districts.join(', ')}` : ''}`,
      lot.historic_district || lot.landmark ? `Historic: ${[lot.historic_district, lot.landmark].filter(Boolean).join('; ')}` : '',
      `Land use: ${lot.land_use ? `${lot.land_use.code} ${lot.land_use.label}` : 'unknown'}${lot.building_class ? `; building class ${lot.building_class}` : ''}`,
      `Lot area: ${fmt(lot.lot_area_sqft, ' sq ft')}; building area: ${fmt(lot.building_area_sqft, ' sq ft')}; floors: ${fmt(lot.num_floors)}; year built: ${lot.year_built ?? 'unknown'}; residential units: ${fmt(lot.residential_units)}`,
      `Recorded MapPLUTO FAR - built: ${fmt(lot.built_far)}; residential: ${fmt(lot.max_far.residential)}; commercial: ${fmt(lot.max_far.commercial)}; community facility: ${fmt(lot.max_far.community_facility)}`,
      `Unused floor area / development capacity: ${u.basis}.`,
      `Caveat: ${u.caveats.join(' ')}`,
      '',
      source,
    ];
    // Optional lines are empty strings; drop them but keep the blank line before the source line.
    const text = lines.filter((l, i) => l !== '' || i === lines.length - 2).join('\n');

    return { ok: true, text, data: { lot, resolved_from: hasBbl ? 'bbl' : 'address', matched_address: matched, full_report_url: reportUrl, district_pages: pages, source } };
  } catch (err) {
    return fail(upstreamMessage(err));
  }
}
