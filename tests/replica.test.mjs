import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solarFrame, inverseAffine, terrainHeight, insidePolygon } from '../src/replica-math.js';

const site = JSON.parse(await readFile(new URL('../public/replica/site.json', import.meta.url), 'utf8'));

test('both solar clusters occupy the traced university compound', () => {
  assert.equal(site.eastRows.length, 3);
  assert.equal(site.southRows.length, 3);
  for (const row of [...site.eastRows, ...site.southRows]) {
    const frame = solarFrame(row, site.origin);
    assert.ok(frame.length > 150 && frame.length < 450);
    assert.ok(frame.width > 4 && frame.width < 12);
    assert.ok(insidePolygon([frame.center[0] + site.origin[0], frame.center[1] + site.origin[1]], site.boundary));
    for (const point of row) assert.ok(insidePolygon(point, site.boundary), 'Array corners must be covered too');
  }
});

test('the perimeter includes every covered-parking footprint', () => {
  assert.equal(site.coveredParking.length, 6);
  for (const canopy of site.coveredParking) for (const point of canopy.points) assert.ok(insidePolygon(point, site.boundary));
});

test('W/T/Z transforms are invertible and map the same physical reference location', () => {
  const point = site.bookmarks.east.slice(0, 2);
  for (const key of ['wide_angle_1', 'thermal_1', 'zoom_1']) {
    const entry = site.registration[key], inv = inverseAffine(entry.sourceToReferenceLocal);
    const source = inv.slice(0, 2).map(row => row[0] * point[0] + row[1] * point[1] + row[2]);
    const ref = entry.sourceToReferenceLocal.slice(0, 2).map(row => row[0] * source[0] + row[1] * source[1] + row[2]);
    assert.ok(Math.hypot(ref[0] - point[0], ref[1] - point[1]) < 1e-7);
    assert.ok(Math.hypot(source[0] - point[0], source[1] - point[1]) < 3);
    const texture = entry.texture;
    const u = (source[0] + site.origin[0] - texture.xmin) / (texture.width * texture.pixelX);
    const v = (texture.ymax - source[1] - site.origin[1]) / (texture.height * texture.pixelY);
    assert.ok(u > 0 && u < 1 && v > 0 && v < 1);
  }
  assert.throws(() => inverseAffine([[0, 0, 1], [0, 0, 1], [0, 0, 1]]), /Degenerate/);
});

test('continuous terrain covers every traced perimeter vertex with finite heights', () => {
  const t = site.terrain;
  assert.equal(t.heights.length, t.width * t.height);
  for (const [x, y] of site.boundary) {
    const localX = x - site.origin[0], localY = y - site.origin[1];
    assert.ok(localX >= t.xmin && localX <= t.xmin + t.stepX * (t.width - 1));
    assert.ok(localY >= t.ymin && localY <= t.ymin + t.stepY * (t.height - 1));
    assert.ok(Number.isFinite(terrainHeight(site, localX, localY)));
  }
});

test('camera height corrections are supported by real LiDAR overlap samples', () => {
  for (const entry of Object.values(site.registration)) {
    assert.ok(entry.vertical.inliers > 100);
    assert.ok(entry.vertical.residualP05P50P95[2] - entry.vertical.residualP05P50P95[0] < 1);
  }
});
