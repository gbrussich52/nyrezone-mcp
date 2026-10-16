import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnusedFloorArea, InputError, mapPlutoRow, parseBbl } from '../lot.js';
import { normalizeStreet, validateAddress } from '../geocode.js';
import { decodeText, ParseError, parseDistrictPage, parseVintage, parseZoningIndex } from '../parse.js';
import { fx } from './helpers.js';

test('parseBbl accepts common forms', () => {
  assert.equal(parseBbl('3052410015'), '3052410015');
  assert.equal(parseBbl(' 3052410015.00000000 '), '3052410015');
  assert.equal(parseBbl('3-05241-0015'), '3052410015');
  assert.equal(parseBbl('3/5241/15'), '3052410015');
});

test('parseBbl rejects malformed input', () => {
  for (const bad of ['', '   ', '123', '305241001', '30524100155', '0052410015', '6052410015', 'abcdefghij', '3052410015; DROP TABLE x', "3052410015' OR '1'='1", '../../etc/passwd', '3052410015&x=1', 'a'.repeat(5000), '3-1-2-3']) {
    assert.throws(() => parseBbl(bad), InputError, `should reject ${JSON.stringify(bad.slice(0, 30))}`);
  }
});

test('validateAddress requires a house number and sane length', () => {
  assert.equal(validateAddress('  1187   Ocean Ave,  Brooklyn '), '1187 Ocean Ave, Brooklyn');
  for (const bad of ['', '   ', 'Ocean Ave', '1187', 'x'.repeat(500), '1187 Ocean\u0000Ave', '<script>alert(1)</script>']) {
    assert.throws(() => validateAddress(bad), InputError);
  }
});

test('normalizeStreet unifies abbreviations and ordinals', () => {
  assert.equal(normalizeStreet('Ocean Ave'), normalizeStreet('OCEAN AVENUE'));
  assert.notEqual(normalizeStreet('Ocean Avenue'), normalizeStreet('Ocean Parkway'));
  assert.equal(normalizeStreet('East 42nd Street'), normalizeStreet('E 42 St'));
});

test('decodeText strips markup, comments and entities', () => {
  assert.equal(decodeText('R6A<!-- --> &amp; <b>x</b> &#x27;y&#x27;'), "R6A & x 'y'");
});

test('parseZoningIndex finds all 51 districts with family labels', () => {
  const idx = parseZoningIndex(fx('zoning.html'));
  assert.equal(idx.length, 51);
  const r6a = idx.find((d) => d.code === 'R6A');
  assert.deepEqual({ slug: r6a?.slug, family: r6a?.family, label: r6a?.familyLabel }, { slug: 'r6a', family: 'R6', label: 'Mid-density apartment' });
  assert.equal(idx.find((d) => d.slug === 'm1-2-r6a')?.code, 'M1-2/R6A');
});

test('parseZoningIndex errors on unrecognized markup', () => {
  assert.throws(() => parseZoningIndex('<html><body>hello</body></html>'), ParseError);
});

test('parseDistrictPage reads the R6A rules table, stats and boroughs', () => {
  const p = parseDistrictPage(fx('zoning_r6a.html'));
  assert.equal(p.code, 'R6A');
  assert.match(p.summary, /mid-density apartment/);
  const far = p.rules.find((r) => r.rule === 'Max residential FAR');
  assert.equal(far?.value, '3.0');
  assert.equal(p.rules.find((r) => r.rule === 'Max building height')?.value, '75 ft');
  assert.equal(p.stats['Parcels citywide'], '15,188');
  assert.equal(p.stats['Avg built FAR'], '2.02');
  assert.deepEqual(p.boroughs[0], { borough: 'Brooklyn', parcels: '9,024' });
  assert.equal(p.dataVintage, 'MapPLUTO 26v2');
});

test('parseDistrictPage handles commercial districts and districts without a rules table', () => {
  const c = parseDistrictPage(fx('zoning_c4-2.html'));
  assert.equal(c.code, 'C4-2');
  assert.ok(c.rules.some((r) => r.rule === 'Commercial FAR' && r.value === '3.4'));
  const m = parseDistrictPage(fx('zoning_m1-2-r6a.html'));
  assert.equal(m.code, 'M1-2/R6A');
  assert.equal(m.rules.length, 0);
  assert.equal(m.stats['Parcels citywide'], '1,335');
});

test('parseDistrictPage errors when the page is not a district page', () => {
  assert.throws(() => parseDistrictPage('<html><body><p>hi</p></body></html>'), ParseError);
});

test('parseVintage reads the release stamp', () => {
  const v = parseVintage(fx('methodology.html'));
  assert.equal(v.release, 'MapPLUTO 26v2');
});

test('mapPlutoRow never carries owner or assessment fields', () => {
  const raw = JSON.parse(fx('pluto_3052410015.json')) as Record<string, unknown>;
  assert.ok('ownername' in raw, 'fixture should keep the raw owner field so the drop is actually tested');
  const lot = mapPlutoRow(raw, '3052410015');
  const dump = JSON.stringify(lot).toLowerCase();
  for (const banned of ['ownername', 'ownertype', 'owner', 'assess', String(raw.ownername).toLowerCase()]) {
    assert.ok(!dump.includes(banned), `lot record must not contain "${banned}"`);
  }
  assert.deepEqual(lot.zoning_districts, ['R7A']);
  assert.equal(lot.lot_area_sqft, 4675);
  assert.equal(lot.year_built, 1910);
  assert.equal(lot.borough, 'Brooklyn');
  assert.deepEqual(lot.land_use, { code: '01', label: 'One & Two Family Buildings' });
});

test('unused floor area: FAR x lot area minus building area', () => {
  const lot = mapPlutoRow(JSON.parse(fx('pluto_3052410015.json')), '3052410015');
  // 4.0 x 4675 = 18700; minus 2606 = 16094
  assert.equal(lot.unused_floor_area.allowed_floor_area_sqft, 18700);
  assert.equal(lot.unused_floor_area.estimate_sqft, 16094);
  assert.equal(lot.unused_floor_area.overbuilt, false);
});

test('unused floor area: overbuilt lot reports zero and flags it (Empire State Building)', () => {
  const lot = mapPlutoRow(JSON.parse(fx('pluto_1008350041.json')), '1008350041');
  assert.equal(lot.split_zone, true);
  assert.equal(lot.unused_floor_area.estimate_sqft, 0);
  assert.equal(lot.unused_floor_area.overbuilt, true);
  assert.ok(lot.unused_floor_area.caveats.some((c) => /more than one zoning district/.test(c)));
  assert.ok(lot.landmark);
});

test('unused floor area: missing inputs give no estimate rather than a number', () => {
  const none = { residential: null, commercial: null, community_facility: null };
  assert.equal(computeUnusedFloorArea(1000, 500, none, false).estimate_sqft, null);
  assert.equal(computeUnusedFloorArea(null, 500, { ...none, residential: 2 }, false).estimate_sqft, null);
  assert.equal(computeUnusedFloorArea(1000, 500, { ...none, commercial: 2 }, false).estimate_sqft, 1500);
});
