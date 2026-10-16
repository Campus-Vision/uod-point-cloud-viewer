import './style.css';
import { Box3, BufferGeometry, Color, Group, Line, LineBasicMaterial, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Instance from '@giro3d/giro3d/core/Instance.js';
import CoordinateSystem from '@giro3d/giro3d/core/geographic/CoordinateSystem.js';
import ColorMap from '@giro3d/giro3d/core/ColorMap.js';
import { GlobalCache } from '@giro3d/giro3d/core/Cache.js';
import PointCloud from '@giro3d/giro3d/entities/PointCloud.js';
import COPCSource from '@giro3d/giro3d/sources/COPCSource.js';
import { setLazPerfPath } from '@giro3d/giro3d/sources/las/config.js';
import { createIcons, Scan, CircleHelp, MapPin, Cloud, X, ChevronDown, HardDrive, SlidersHorizontal, Box, Layers2, Maximize, RotateCcw, Expand, TriangleAlert, EyeOff, ArrowUpRight } from 'lucide';
import { expandSurveyColour } from './colour.js';

createIcons({ icons: { Scan, CircleHelp, MapPin, Cloud, X, ChevronDown, HardDrive, SlidersHorizontal, Box, Layers2, Maximize, RotateCcw, Expand, TriangleAlert, EyeOff, ArrowUpRight } });

const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const state = { ready: false, error: null, requests: 0, bytes: 0, readErrors: 0, colour: 'Color', view: 'campus', routeReady: false };
let instance, cloud, source, controls, manifest, routeGroup, campusCenter, fullBounds;
let timer, toastTimer, resizeTimer, controlsMoved = false, firstPointsAt = null;
const palettes = { slate: '#283f4b', light: '#e1e9ed', dark: '#101c24' };
const colours = ['#285b9e', '#36a5b6', '#8ac692', '#e4cd69', '#dc855f'];
const colourRamp = (stops, count = 128) => Array.from({ length: count }, (_, i) => {
  const t = i / (count - 1) * (stops.length - 1);
  const index = Math.min(Math.floor(t), stops.length - 2);
  return new Color(stops[index]).lerp(new Color(stops[index + 1]), t - index);
});

function notify() { instance?.notifyChange(cloud); }
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function fail(message, error) {
  state.error = message;
  $('loading-state').hidden = true;
  $('error-message').textContent = message;
  $('error-state').hidden = false;
  $('status-text').textContent = 'Survey unavailable';
  $('status-dot').className = 'status-dot error';
  if (error) console.error(error);
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot read ${url}: HTTP ${response.status}`);
  return response.json();
}

// Reject a server that ignores ranges: never accidentally download the entire 1.39 GB file.
async function getCloudRange(begin, end) {
  try {
    const response = await fetch('/survey/cloud.copc.laz', { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`Point-cloud server returned HTTP ${response.status}; expected a byte range (206).`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength !== end - begin) throw new Error('Incomplete point-cloud byte range.');
    state.requests++;
    state.bytes += buffer.byteLength;
    return buffer;
  } catch (error) {
    state.readErrors++;
    if (state.ready) fail('Point-cloud streaming was interrupted. Check that the local server is running, then try again.', error);
    throw error;
  }
}

class SurveySource extends COPCSource {
  async getNodeData(params) {
    try {
      const data = await super.getNodeData(params);
      for (let i = 0; i < (params.attributes?.length ?? 0); i++) {
        if (params.attributes[i].name === 'Color' && data.attributes[i]) {
          expandSurveyColour(data.attributes[i].array);
          data.attributes[i].needsUpdate = true;
        }
      }
      return data;
    } catch (error) {
      if (!params.signal?.aborted && !state.error) fail('A survey tile could not be decoded. Try reopening the viewer.', error);
      throw error;
    }
  }
}

function setCamera(view) {
  if (!controls || !campusCenter) return;
  controlsMoved = false;
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  state.view = view;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  const target = view === 'full' ? fullBounds.getCenter(new Vector3()) : campusCenter.clone();
  if (view === 'full') target.z = campusCenter.z;
  const camera = instance.view.camera;
  const aspect = Math.max(0.3, camera.aspect);
  const framing = Math.max(1, 1 / aspect);
  if (view === 'full') {
    const size = fullBounds.getSize(new Vector3());
    const distance = Math.max(size.x / aspect, size.y) / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.14;
    camera.position.copy(target).add(new Vector3(0, -distance * 0.65, distance * 0.9));
  } else if (view === 'top') {
    const height = Math.max(320, 245 / aspect) / Math.tan(camera.fov * Math.PI / 360);
    camera.position.copy(target).add(new Vector3(0, -0.01, height));
  } else {
    camera.position.copy(target).add(new Vector3(110, -455, 365).multiplyScalar(framing));
  }
  controls.target.copy(target);
  controls.update();
  controls.enableDamping = damping;
  camera.lookAt(target);
  camera.updateMatrixWorld();
  controlsMoved = false;
  instance.notifyChange(camera);
  updateHUD();
}

function setColour(attribute) {
  if (!state.ready) return;
  state.colour = attribute;
  cloud.setActiveAttribute(attribute);
  document.querySelectorAll('[data-colour]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.colour === attribute)));
  const elevation = attribute === 'Z';
  const intensity = attribute === 'Intensity';
  $('legend').hidden = !(elevation || intensity);
  $('legend-title').textContent = elevation ? 'Elevation' : 'Return intensity';
  $('legend-min').textContent = elevation ? `${manifest.bounds[2].toFixed(1)} m` : '10,000';
  $('legend-max').textContent = elevation ? `${manifest.bounds[5].toFixed(1)} m` : '65,535';
  $('legend-caption').textContent = elevation ? 'Survey elevation · datum unverified' : 'Laser return strength · raw sensor values';
  $('legend-ramp').style.background = elevation ? `linear-gradient(90deg,${colours.join(',')})` : 'linear-gradient(90deg,#263b4a,#f5f7f8)';
  $('colour-note').textContent = elevation ? 'Colour shows recorded survey elevation.' : intensity ? 'Brightness shows laser return strength.' : 'Original colours captured by the scanner.';
  notify();
}

function setQuality(value) {
  const mode = { fast: [1_000_000, 2.2], balanced: [2_000_000, 1.4], high: [4_000_000, 1.0] }[value];
  cloud.pointBudget = mode[0];
  cloud.subdivisionThreshold = mode[1];
  notify();
}

function updateHUD() {
  if (!controls || !instance) return;
  const camera = instance.view.camera;
  const direction = camera.position.clone().sub(controls.target);
  const angle = Math.atan2(direction.x, -direction.y) * 180 / Math.PI;
  $('north-arrow').style.transform = `rotate(${angle}deg)`;
  const metresPerPixel = 2 * direction.length() * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, $('view').clientHeight);
  const targetMetres = metresPerPixel * 100;
  const power = 10 ** Math.floor(Math.log10(Math.max(0.01, targetMetres)));
  const options = [1, 2, 5, 10].map(x => x * power);
  const metres = options.reduce((a, b) => Math.abs(a - targetMetres) < Math.abs(b - targetMetres) ? a : b);
  $('scale-label').textContent = `${metres >= 1 ? metres.toFixed(0) : metres.toFixed(1)} m`;
  $('scale-line').style.width = `${Math.min(150, Math.max(35, metres / metresPerPixel))}px`;
}

function updateStatus() {
  if (!state.ready || state.error) return;
  const displayed = cloud.visible ? cloud.displayedPointCount : 0;
  $('displayed-points').textContent = compact.format(displayed);
  const loading = cloud.visible && (source.loading || cloud.loading);
  $('status-text').textContent = !cloud.visible ? 'Point cloud hidden' : loading ? 'Streaming visible detail' : 'Ready to explore';
  $('status-dot').className = `status-dot${loading ? '' : ' ready'}`;
  if (displayed > 0 && !firstPointsAt) firstPointsAt = performance.now();
  $('loading-state').classList.toggle('is-streaming', displayed > 0);
  $('loading-state').hidden = !cloud.visible || (!loading && displayed > 0);
  $('loading-title').textContent = displayed > 0 ? 'Refining visible detail' : 'Loading the campus';
  $('loading-description').textContent = 'Decoding survey points in the background…';
  if (!displayed && cloud.visible && !loading && firstPointsAt) $('loading-state').hidden = true;
}

async function loadRoute() {
  const route = await json('/survey/route.json');
  routeGroup = new Group();
  routeGroup.name = 'Scanning route';
  routeGroup.position.copy(campusCenter);
  const material = new LineBasicMaterial({ color: '#f2a18a', depthTest: false, transparent: true, opacity: 0.95 });
  for (const line of route.lines) {
    const points = line.map(([x, y, z]) => new Vector3(x - campusCenter.x, y - campusCenter.y, z - campusCenter.z + 0.2));
    const geometry = new BufferGeometry().setFromPoints(points);
    const object = new Line(geometry, material);
    object.renderOrder = 10;
    routeGroup.add(object);
  }
  routeGroup.visible = $('route-visible').checked;
  // Giro3D disables scene-wide matrix propagation; update ordinary Three.js overlays explicitly.
  routeGroup.updateMatrixWorld(true);
  await instance.add(routeGroup);
  state.routeReady = true;
  $('route-visible').disabled = false;
  notify();
}

async function init() {
  try {
    manifest = await json('/survey/manifest.json');
    $('total-points').textContent = format.format(manifest.pointCount);
    $('file-size').textContent = `${(manifest.bytes / 1e9).toFixed(2)} GB`;
    const [minX, minY, minZ, maxX, maxY, maxZ] = manifest.bounds;
    $('extent').textContent = `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} m`;
    $('height-range').textContent = `${minZ.toFixed(2)}–${maxZ.toFixed(2)} m`;
    fullBounds = new Box3(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
    campusCenter = new Vector3(340125, 2777645, 57);
    const crs = CoordinateSystem.register('EPSG:32640', manifest.projection);
    // Vite emits this local WASM asset alongside the bundle; no CDN is needed.
    const wasmResponse = await fetch('/wasm/laz-perf.wasm');
    if (!wasmResponse.ok) throw new Error('The local LAZ decoder is unavailable.');
    // Giro3D's worker loader expects this exact filename at the supplied directory.
    setLazPerfPath('/wasm');
    GlobalCache.configure({ byteCapacity: 256 * 1024 * 1024, maxNumberOfEntries: 2048 });
    instance = new Instance({
      target: $('view'), crs, backgroundColor: palettes.slate,
      renderer: { antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' },
    });
    instance.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    instance.view.camera.up.set(0, 0, 1);
    instance.view.camera.fov = 48;
    instance.view.camera.updateProjectionMatrix();
    instance.renderingOptions.enableEDL = true;
    instance.renderingOptions.EDLStrength = 0.7;
    instance.renderingOptions.enableMSAA = false;
    controls = new OrbitControls(instance.view.camera, instance.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.minDistance = 2;
    controls.maxDistance = 4000;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    instance.view.setControls(controls);
    controls.addEventListener('start', () => { controlsMoved = true; });
    controls.addEventListener('change', () => {
      if (controlsMoved) {
        state.view = 'custom';
        document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', 'false'));
      }
      updateHUD();
    });
    source = new SurveySource({ url: getCloudRange, enableWorkers: true, compressColorsTo8Bit: false });
    cloud = new PointCloud({ source, cleanupDelay: 4000 });
    cloud.pointSize = 2;
    cloud.pointBudget = 2_000_000;
    cloud.setAttributeColorMap('Z', new ColorMap({ colors: colourRamp(colours), min: minZ, max: maxZ }));
    cloud.setAttributeColorMap('Intensity', new ColorMap({ colors: colourRamp(['#263b4a', '#f5f7f8']), min: 10000, max: 65535 }));
    setCamera('campus');
    await instance.add(cloud);
    cloud.subdivisionThreshold = 1.4;
    state.ready = true;
    cloud.setActiveAttribute('Color');
    $('appearance-controls').disabled = false;
    $('layer-controls').disabled = false;
    $('route-visible').disabled = true;
    loadRoute().catch(error => { console.warn(error); toast('Scanning route unavailable. The point cloud is still available.'); });
    setCamera('campus');
    notify();
    source.addEventListener('progress', updateStatus);
    timer = setInterval(updateStatus, 300);
    updateStatus();
    instance.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      fail('The graphics context was lost. Close other graphics-heavy tabs and try again.');
    });
    instance.domElement.addEventListener('dblclick', event => {
      if (!cloud.visible) return;
      try {
        const hit = instance.pickObjectsAt(event, { radius: 4, where: [cloud], limit: 1 })[0];
        if (hit) {
          const offset = instance.view.camera.position.clone().sub(controls.target);
          controls.target.copy(hit.point);
          instance.view.camera.position.copy(hit.point).add(offset);
          controls.update();
          instance.notifyChange(instance.view.camera);
          toast('Orbit centre moved to this surface');
        }
      } catch (error) { console.warn('Point focus unavailable', error); }
    });
    // Read-only diagnostics for verification and local troubleshooting.
    window.uodViewer = { state, instance, cloud, source, controls, manifest, get route() { return routeGroup; } };
  } catch (error) {
    fail('Check that the COPC file is in the LiDAR folder and start the viewer with Start viewer.cmd. Your browser also needs WebGL 2 enabled.', error);
  }
}

document.querySelectorAll('[data-colour]').forEach(button => button.addEventListener('click', () => setColour(button.dataset.colour)));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setCamera(button.dataset.view)));
$('fit-button').addEventListener('click', () => setCamera('full'));
$('reset-button').addEventListener('click', () => setCamera('campus'));
$('point-size').addEventListener('input', event => {
  $('point-size-output').textContent = `${event.target.value} px`;
  if (cloud) { cloud.pointSize = Number(event.target.value); notify(); }
});
$('quality').addEventListener('change', event => { if (cloud) setQuality(event.target.value); });
$('edl').addEventListener('change', event => { if (instance) { instance.renderingOptions.enableEDL = event.target.checked; notify(); } });
function showCloud(visible) {
  if (!cloud) return;
  cloud.visible = visible;
  $('cloud-visible').checked = visible;
  $('empty-state').hidden = visible;
  $('legend').hidden = !visible || state.colour === 'Color';
  notify(); updateStatus();
}
$('cloud-visible').addEventListener('change', event => showCloud(event.target.checked));
$('show-cloud').addEventListener('click', () => showCloud(true));
$('route-visible').addEventListener('change', event => { if (routeGroup) { routeGroup.visible = event.target.checked; notify(); } });
$('background').addEventListener('change', event => {
  $('scene').dataset.background = event.target.value;
  if (instance) { instance.engine.clearColor = palettes[event.target.value]; notify(); }
});
$('retry-button').addEventListener('click', () => window.location.reload());
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('scene').requestFullscreen();
  } catch { toast('Full screen is unavailable in this browser.'); }
});
document.addEventListener('fullscreenchange', () => $('fullscreen-button').setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Enter full screen'));

function help(open) {
  $('help-panel').hidden = !open;
  $('help-button').setAttribute('aria-expanded', String(open));
  if (open) $('close-help').focus();
  else $('help-button').focus();
}
$('help-button').addEventListener('click', () => help($('help-panel').hidden));
$('close-help').addEventListener('click', () => help(false));
function panel(open) {
  $('sidebar').classList.toggle('open', open);
  $('drawer-backdrop').hidden = !open;
  $('open-panel').setAttribute('aria-expanded', String(open));
  $('sidebar').inert = !open && window.innerWidth <= 700;
  if (open) $('close-panel').focus();
  else $('open-panel').focus();
}
$('open-panel').addEventListener('click', () => panel(true));
$('close-panel').addEventListener('click', () => panel(false));
$('drawer-backdrop').addEventListener('click', () => panel(false));
const narrowScreen = window.matchMedia('(max-width: 700px)');
function updatePanelAccessibility() {
  $('sidebar').inert = narrowScreen.matches && !$('sidebar').classList.contains('open');
  if (!narrowScreen.matches) {
    $('sidebar').classList.remove('open');
    $('drawer-backdrop').hidden = true;
    $('open-panel').setAttribute('aria-expanded', 'false');
  }
}
narrowScreen.addEventListener('change', updatePanelAccessibility);
updatePanelAccessibility();
document.addEventListener('keydown', event => {
  const editing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (event.key === 'Escape') {
    if (!$('help-panel').hidden) help(false);
    if ($('sidebar').classList.contains('open')) panel(false);
  }
  if (event.key === 'Tab' && $('sidebar').classList.contains('open') && narrowScreen.matches) {
    const items = [...$('sidebar').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')].filter(el => el.getClientRects().length);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (editing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'r') setCamera('campus');
  if (event.key.toLowerCase() === 't') setCamera('top');
});
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.ready && state.view !== 'custom') setCamera(state.view);
    else updateHUD();
  }, 160);
});
window.addEventListener('pagehide', () => { clearInterval(timer); clearTimeout(toastTimer); clearTimeout(resizeTimer); instance?.dispose(); });
init();
