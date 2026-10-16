export function solarFrame(row, origin) {
  const p = row.map(([x, y]) => [x - origin[0], y - origin[1]]);
  const center = p.reduce((s, v) => [s[0] + v[0] / 4, s[1] + v[1] / 4], [0, 0]);
  let a = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
  let b = [p[3][0] - p[0][0], p[3][1] - p[0][1]];
  if (Math.hypot(...a) < Math.hypot(...b)) [a, b] = [b, a];
  const length = Math.hypot(...a), width = Math.hypot(...b);
  const along = a.map(v => v / length), across = [-along[1], along[0]];
  return { center, along, across, length, width };
}

export function inverseAffine(matrix) {
  const [[a, b, x], [c, d, y]] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 0.1) throw new Error('Degenerate capture registration.');
  return [[d / determinant, -b / determinant, (b * y - d * x) / determinant], [-c / determinant, a / determinant, (c * x - a * y) / determinant], [0, 0, 1]];
}

export function terrainHeight(site, x, y) {
  const t = site.terrain;
  const col = (x - t.xmin) / t.stepX, row = (y - t.ymin) / t.stepY;
  if (col < 0 || row < 0 || col > t.width - 1 || row > t.height - 1) return site.groundPlane[0] * x + site.groundPlane[1] * y + site.groundPlane[2];
  const c = Math.min(t.width - 2, Math.floor(col)), r = Math.min(t.height - 2, Math.floor(row));
  const fx = col - c, fy = row - r, i = r * t.width + c;
  return t.heights[i] * (1 - fx) * (1 - fy) + t.heights[i + 1] * fx * (1 - fy) + t.heights[i + t.width] * (1 - fx) * fy + t.heights[i + t.width + 1] * fx * fy;
}

export function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x, y] = point, [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
