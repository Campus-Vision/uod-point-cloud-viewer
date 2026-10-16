import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import proj4 from 'proj4';

export const root = path.resolve(import.meta.dirname, '../..');
export const cloudPath = path.join(root, '20261008121946091.copc.laz');
const routePath = path.join(root, '@@2026-10-08-081521_REFINE2_Scanner1.kml');

// A single byte range is all COPC needs. Reject multipart and invalid ranges.
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end };
}

export async function serveCloud(req, res, file = cloudPath) {
  const info = await stat(file);
  const range = parseRange(req.headers.range, info.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (range === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  res.setHeader('Content-Length', end - start + 1);
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  res.statusCode = range ? 206 : 200;
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

let manifestPromise;
async function manifest() {
  const f = await open(cloudPath, 'r');
  let h;
  try {
    h = Buffer.alloc(375);
    await f.read(h, 0, h.length, 0);
  } finally { await f.close(); }
  if (h.toString('ascii', 0, 4) !== 'LASF') throw new Error('The survey file is not LAS/COPC.');
  const bounds = [187, 203, 219, 179, 195, 211].map(offset => h.readDoubleLE(offset));
  return {
    name: 'University of Dubai',
    file: path.basename(cloudPath),
    pointCount: Number(h.readBigUInt64LE(247)),
    bytes: (await stat(cloudPath)).size,
    bounds,
    projection: '+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs',
    crsLabel: 'WGS 84 / UTM 40N',
    verticalReference: 'Vertical datum unverified',
    acquisitionDate: '2026-10-08',
  };
}

export async function getRoute() {
  const kml = await readFile(routePath, 'utf8');
  const lines = [...kml.matchAll(/<coordinates>\s*([\s\S]*?)\s*<\/coordinates>/g)].map(match =>
    match[1].trim().split(/\s+/).map(tuple => {
      const [lon, lat, z] = tuple.split(',').map(Number);
      const [x, y] = proj4('EPSG:4326', '+proj=utm +zone=40 +datum=WGS84 +units=m +no_defs', [lon, lat]);
      return [x, y, z];
    }),
  );
  return { lines, source: path.basename(routePath), description: 'Scanner trajectory; not the survey boundary.' };
}

export function surveyMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/survey/')) return next();
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  (async () => {
    if (url.pathname === '/survey/cloud.copc.laz') return serveCloud(req, res);
    let data;
    if (url.pathname === '/survey/manifest.json') data = await (manifestPromise ??= manifest().catch(e => { manifestPromise = null; throw e; }));
    else if (url.pathname === '/survey/route.json') data = await getRoute();
    else { res.writeHead(404); res.end(); return; }
    const body = JSON.stringify(data);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  })().catch(error => {
    console.error('Survey request failed:', error.message);
    if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Survey unavailable. Keep the COPC and KML files in the parent folder, then restart the viewer.' })); }
    else res.destroy();
  });
}
