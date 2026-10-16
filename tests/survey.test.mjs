import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseRange, serveCloud, getRoute, cloudPath } from '../server/survey.mjs';

test('COPC byte ranges include bounded, open-ended, and suffix requests', () => {
  assert.deepEqual(parseRange('bytes=0-588', 1000), { start: 0, end: 588 });
  assert.deepEqual(parseRange('bytes=998-', 1000), { start: 998, end: 999 });
  assert.deepEqual(parseRange('bytes=-20', 1000), { start: 980, end: 999 });
  assert.deepEqual(parseRange('bytes=950-1200', 1000), { start: 950, end: 999 });
  for (const invalid of ['bytes=1000-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'junk']) assert.equal(parseRange(invalid, 1000), false);
});

test('the actual survey streams ranges without sending the full file', async () => {
  const server = http.createServer((req, res) => serveCloud(req, res, cloudPath).catch(e => { res.statusCode = 500; res.end(e.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(url, { headers: { Range: 'bytes=0-588' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), '589');
    const header = Buffer.from(await response.arrayBuffer());
    assert.equal(header.length, 589);
    assert.equal(header.toString('ascii', 0, 4), 'LASF');
    assert.equal(Number(header.readBigUInt64LE(247)), 200700295);
    assert.equal((await fetch(url, { headers: { Range: 'bytes=99999999999-' } })).status, 416);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '1390782721');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('KML trajectory projects into the same metre-based campus space', async () => {
  const route = await getRoute();
  assert.equal(route.lines.length, 2);
  assert.equal(route.lines.reduce((n, line) => n + line.length, 0), 1315);
  for (const line of route.lines) for (const [x, y, z] of line) {
    assert.ok(x > 339000 && x < 341000);
    assert.ok(y > 2777000 && y < 2779000);
    assert.ok(z > 0 && z < 200);
  }
});
