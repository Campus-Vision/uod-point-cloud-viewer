# UoD 3D — campus point-cloud viewer

This project is the original progressive University of Dubai LiDAR viewer. The campus replica now runs as an independent React project in `../campus-replica/`.

## Campus replica

Open **http://127.0.0.1:5174/**, or double-click **Start campus replica.cmd** in the parent folder. The current replica uses original measured building points with reversible natural-colour controls. See `../campus-replica/README.md`. The replica implementation notes below describe the earlier fitted model and retained asset-preparation pipeline.

The replica covers the complete image-traced compound, including parking areas, six covered-parking structures, internal roads and entrances, the courtyard, landscape, and both solar clusters. Bookmarks open the whole compound, the university building, the larger eastern array, or the southern array. The perimeter toggle shows the extent used by the reconstruction; it is not a cadastral boundary.

**Normal / W / T / Z:** Normal renders photovoltaic materials on the eastern array. W, T and Z project the supplied wide, thermal and zoom orthophotography onto the exact same corrected three-dimensional eastern surface. Changing captures preserves the geometry and camera; choosing a capture from another location first opens the east array. Texture downloads are cached and failed downloads preserve the previous mode for retry. The southern array has modelled modules and supports aligned to aerial footprints; no thermal or zoom captures were supplied for it.

All datasets use WGS 84 / UTM 40N. The three photogrammetry outputs share a horizontal origin but have different vertical offsets. Robust plane corrections fit their overlapping DSM samples to LiDAR. Horizontal registration uses matched wide/zoom features and a constrained thermal edge correlation. GPU texture projection uses local coordinates to preserve precision. See `public/replica/site.json` for transforms, support counts, residuals, model notes and traced footprints. These fits support visual inspection, not certified metrology, particularly beyond the overlap area. Thermal textures are the recorded colour palette, not calibrated temperature measurements.

**Reconstruction limits:** The building uses aerial-traced curved roof forms with LiDAR-constrained roof elevations. Facades and windows are modelled; they are not captured facade photographs. Ground is a continuous terrain mesh fitted to the LiDAR and corrected wide-camera DSM, coloured by a georeferenced Esri World Imagery export. Tree positions follow detected aerial crowns, with modelled tree shapes. Parking canopies, landscape details and southern photovoltaic structures are inferred from imagery. The actual measured scan remains available for comparison. Original source files have not been modified.

Source provenance is recorded in `public/replica/provenance.json`, and imagery attribution is displayed in the scene. The source map service is [Esri World Imagery](https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer).

### Replica verification

```powershell
npm test
node tests/replica-browser.mjs
```

Browser checks verify that the complete perimeter is initially framed; both solar clusters exist; W/T/Z preserves camera, target and surface identity; controls and mobile drawer work; and the browser has no unexpected request or console errors. Unit checks include every solar-array corner and covered-parking footprint within the traced perimeter. Captures and results are under `../.impeccable/review/replica/`.

The asset preparation script is `scripts/build-replica.py`, run from the parent directory with Python, NumPy, SciPy and Pillow. It also uses isolated OpenCV installed under `../analysis/python-packages`, the georeferenced aerial reference and preparation records under `../analysis/`, and the owner's existing processed datasets. All inputs are read-only; outputs go to `public/replica/`. Existing generated assets are sufficient to run and build the app; Python and the preparation inputs are not needed for normal use. The analytical `lidar-surfaces-reference.glb` is a raw upper-surface diagnostic and is not used as the campus architecture.

## Open the viewer

Double-click **Start viewer.cmd** in the parent LiDAR folder. Keep its terminal window open while using the viewer. It opens **http://127.0.0.1:5173/** once the server is ready. Stop with Ctrl+C. If the server is already running, open that address directly.

Chrome or Edge with WebGL 2 enabled is recommended. Node.js 22.12+ is needed for the development server. Installed dependencies, fonts, the LAZ decoder, and survey data are local; subsequent use does not need a third-party data service.

From this directory:

```powershell
npm install
npm run dev
```

## Explore

- Left-drag to orbit; right-drag to pan; scroll to zoom. Touch uses one finger to orbit and two fingers to pan or pinch.
- Double-click a captured surface to move the orbit centre.
- **Campus** opens the building-focused perspective. **Top** looks down with north upward. **Fit survey** includes the complete measured extents, including peripheral scan points.
- **R** resets to campus; **T** selects top view. Shortcuts do not override inputs or selects.
- **Natural**, **Elevation**, and **Intensity** change point colouring. Elevation is recorded survey Z, with an unverified vertical datum. Intensity is raw laser return strength, not temperature.
- Change point size and detail, toggle depth enhancement, or choose a background. High detail increases memory and graphics work.
- Enable the KML scanning route to inspect the scanner path. The line is drawn over surfaces for legibility and does not indicate a coverage boundary.
- On narrow screens, open **Controls** to access settings.

## Source data and rendering

The local server serves only the mapped cloud, a small survey manifest, and the projected KML trajectory under `/survey/`. It does not expose arbitrary parent-folder files.

Keep these files in the parent directory:

```text
20261008121946091.copc.laz
@@2026-10-08-081521_REFINE2_Scanner1.kml
```

The original LAS and PosL are preserved. No source data is edited, moved, or duplicated. The COPC contains **200,700,295 points** and occupies **1,390,782,721 bytes**. The viewer streams visible spatial nodes using HTTP 206 byte ranges. It rejects servers that ignore range requests rather than downloading the whole file. LAZ decoding runs in background workers. Node-local positions maintain rendering precision while the geographic reference remains WGS 84 / UTM zone 40N.

The renderer is **Giro3D 2.0.5**, built on **Three.js 0.180**, using the existing COPC directly instead of converting it into Potree's format. Displayed point budgets are targets implemented by progressive detail and decimation; they are not hard total-memory limits. The compressed-tile cache is capped at 256 MiB and hidden geometry is released after four seconds. Full point density appears only where requested by the current view and detail setting.

This CHCNAV scan stores 0–255 RGB values in 16-bit LAS fields. The adapter expands these values only in GPU-bound colour buffers so the scan retains its natural appearance. The file itself remains unchanged.

Missing surfaces are left empty. No inferred roofs, walls, or imagery are inserted into this measured-data viewer. Gaps may be scan occlusions or current level of detail. Alignment is useful for inspection, not certified survey accuracy.

## Verify and build

```powershell
npm test
npm run build
node tests/browser.mjs
```

The browser test requires a running development server on port 5173 and an installed Chrome browser. It exercises the actual local dataset. Review captures and results are saved under `../.impeccable/review/`.

For a compiled local viewer, run `npm run build` then `npm run preview`. Preview retains the survey range middleware. Opening `dist/index.html` directly or serving only `dist/` will not provide the point cloud: `/survey/` requires the local server. To host elsewhere in the future, provide byte-range-capable storage for the COPC and update the data endpoint; do not upload all source files as ordinary UI assets.

## Troubleshooting

- **Port in use:** open the existing viewer at port 5173 or stop its terminal before starting another instance.
- **No points:** use Campus or Fit survey, confirm Point cloud is enabled, and wait for visible detail to stream.
- **Graphics context lost:** close other graphics-heavy tabs, reload, and choose Fast detail.
- **File unavailable:** keep the expected COPC and KML filenames in the parent folder, then restart.

## Dependencies and attribution

Giro3D (MIT), Three.js (MIT), laz-perf (Apache-2.0), Lucide icons (ISC), Manrope (SIL Open Font License), Vite (MIT), OpenLayers (BSD-2-Clause), and proj4 (MIT). The WASM file in `public/wasm/` is distributed from `laz-perf@0.0.7`. No external basemap, satellite imagery, or generated visual assets are shipped.
# Current project split

The campus replica now lives in the independent React project `../campus-replica/`, on port 5174. Use the parent **Start campus replica.cmd**. Its building uses original measured points, replacing the earlier fitted architectural model. This folder remains the original COPC point-cloud viewer on port 5173. The replica details below describe the earlier implementation and asset preparation; see `../campus-replica/README.md` for the current replica.

