import './replica.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createIcons, Scan, CircleHelp, MapPin, X, ChevronDown, HardDrive, SlidersHorizontal, Box, Layers2, RotateCcw, Expand, TriangleAlert, ArrowUpRight, LandPlot, Building2, PanelsTopLeft, ChevronRight, Crosshair } from 'lucide';
import { solarFrame, inverseAffine, terrainHeight } from './replica-math.js';

createIcons({ icons: { Scan, CircleHelp, MapPin, X, ChevronDown, HardDrive, SlidersHorizontal, Box, Layers2, RotateCcw, Expand, TriangleAlert, ArrowUpRight, LandPlot, Building2, PanelsTopLeft, ChevronRight, Crosshair } });
const $ = id => document.getElementById(id);
const asset = name => `/replica/${name}`;
const state = { ready: false, place: 'compound', angle: 'perspective', capture: 'normal', pendingCapture: null, error: null, transition: false, geometries: {}, textureLoads: 0 };
let site, scene, renderer, camera, controls, sun, hemi, terrain, building, facades, eastSurface, landscape, southArray, eastSupports, parkingSupports, perimeter;
let dirty = true, transition = null, settingCamera = false, resizeTimer, toastTimer, captureSequence = 0, shownProgress = 5;
const textureCache = new Map(), labels = [];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const captureUniforms = { uCaptureMode: { value: 0 }, uCaptureMap: { value: null }, uSolarMaterialMap: { value: null }, uReferenceToSource: { value: new THREE.Matrix3() }, uCaptureExtent: { value: new THREE.Vector4() }, uRowCenters: { value: [] }, uRowAxes: { value: [] }, uRowSizes: { value: [] } };
const placeNames = { compound: 'Entire compound', building: 'University building', east: 'East solar array', south: 'South solar array' };
const descriptions = { normal: 'The textured, three-dimensional campus.', wide: 'Wide-camera imagery on the eastern panel surfaces.', thermal: 'Thermal imagery registered to the same eastern panels.', zoom: 'Zoom-camera detail on the same eastern panel surfaces.' };

function invalidate() { dirty = true; }
function toast(message) {
  $('replica-toast').textContent = message; $('replica-toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('replica-toast').hidden = true; }, 5000);
}
function fail(error) {
  state.error = error.message;
  $('replica-loading').hidden = true; $('replica-error').hidden = false;
  $('replica-error-detail').textContent = 'Keep the local viewer running and try again. If this continues, check that the generated replica assets are in viewer/public/replica.';
  $('replica-status').textContent = 'Campus unavailable'; $('replica-status-dot').className = 'status-dot error';
  console.error(error);
}
function progress(value, text) {
  shownProgress = Math.max(shownProgress, Math.min(100, value));
  $('load-progress-fill').style.transform = `scaleX(${shownProgress/100})`;
  $('replica-loading-detail').textContent = text;
}

function modelMaterial(model, options = {}) {
  model.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.computeVertexNormals();
    object.castShadow = true; object.receiveShadow = true;
    const mats = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of mats) {
      material.roughness = options.roughness ?? .92;
      material.metalness = options.metalness ?? 0;
      material.side = THREE.DoubleSide;
      if (material.map) { material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); }
      material.needsUpdate = true;
    }
  });
}

function configureEastMaterial() {
  const frames = site.eastRows.map(row => solarFrame(row, site.origin));
  captureUniforms.uRowCenters.value = frames.map(f => new THREE.Vector2(...f.center));
  captureUniforms.uRowAxes.value = frames.map(f => new THREE.Vector4(...f.along, ...f.across));
  captureUniforms.uRowSizes.value = frames.map(f => new THREE.Vector2(f.length / 2 + .12, f.width / 2 + .12));
  captureUniforms.uSolarMaterialMap.value = makeModuleTexture();
  eastSurface.traverse(object => {
    if (!object.isMesh) return;
    object.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, captureUniforms);
      shader.vertexShader = `varying vec2 vCampusXY;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCampusXY = (modelMatrix * vec4(transformed, 1.0)).xy;');
      shader.fragmentShader = `
        varying vec2 vCampusXY;
        uniform int uCaptureMode;
        uniform sampler2D uCaptureMap;
        uniform sampler2D uSolarMaterialMap;
        uniform mat3 uReferenceToSource;
        uniform vec4 uCaptureExtent;
        uniform vec2 uRowCenters[3];
        uniform vec4 uRowAxes[3];
        uniform vec2 uRowSizes[3];
        bool onSolarSurface(vec2 p) {
          for (int i=0;i<3;i++) {
            vec2 d=p-uRowCenters[i];
            if(abs(dot(d,uRowAxes[i].xy)) < uRowSizes[i].x && abs(dot(d,uRowAxes[i].zw)) < uRowSizes[i].y) return true;
          }
          return false;
        }
        ${shader.fragmentShader}`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        bool hasCapture = uCaptureMode > 0 && onSolarSurface(vCampusXY);
        vec4 captureSample = vec4(0.0);
        if(uCaptureMode==0){
          for(int row=0;row<3;row++){
            vec2 d=vCampusXY-uRowCenters[row];
            float along=dot(d,uRowAxes[row].xy),across=dot(d,uRowAxes[row].zw);
            if(abs(along)<uRowSizes[row].x && abs(across)<uRowSizes[row].y){
              vec2 moduleUV=vec2(fract((across+uRowSizes[row].y)/1.03),fract((along+uRowSizes[row].x)/1.94));
              diffuseColor.rgb=texture2D(uSolarMaterialMap,moduleUV).rgb;
            }
          }
        }
        if (hasCapture) {
          vec2 sourceXY=(uReferenceToSource*vec3(vCampusXY,1.0)).xy;
          vec2 captureUV=vec2((sourceXY.x-uCaptureExtent.x)/uCaptureExtent.z,(uCaptureExtent.y-sourceXY.y)/uCaptureExtent.w);
          hasCapture=all(greaterThanEqual(captureUV,vec2(0.0))) && all(lessThanEqual(captureUV,vec2(1.0)));
          if(hasCapture){captureSample=texture2D(uCaptureMap,captureUV);diffuseColor.rgb=captureSample.rgb;}
        }
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif(uCaptureMode==0 && onSolarSurface(vCampusXY)){roughnessFactor=.36;}');
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nif(uCaptureMode==0 && onSolarSurface(vCampusXY)){metalnessFactor=.28;}');
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        if(hasCapture && uCaptureMode==2){totalEmissiveRadiance=captureSample.rgb;diffuseColor.rgb=vec3(0.0);}
      `);
    };
    object.material.customProgramCacheKey = () => 'campus-registered-captures-v1';
    object.material.needsUpdate = true;
  });
}

function makeModuleTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 512;
  const context = canvas.getContext('2d');
  context.fillStyle = '#a9b7ba'; context.fillRect(0, 0, 256, 512);
  context.fillStyle = '#102a3a'; context.fillRect(4, 4, 248, 504);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 6; x++) {
    const level = 29 + ((x * 7 + y * 3) % 9);
    context.fillStyle = `rgb(${level - 8},${level + 11},${level + 25})`;
    context.fillRect(7 + x * 41, 7 + y * 41.6, 39, 39.6);
    context.strokeStyle = '#88a3ac'; context.lineWidth = .6;
    context.beginPath(); context.moveTo(8 + x * 41, 20 + y * 41.6); context.lineTo(44 + x * 41, 20 + y * 41.6); context.stroke();
    context.beginPath(); context.moveTo(8 + x * 41, 34 + y * 41.6); context.lineTo(44 + x * 41, 34 + y * 41.6); context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; return texture;
}

function makeSolarArray(rows, modelPanels, planes = null) {
  const group = new THREE.Group();
  const frames = rows.map(row => solarFrame(row, site.origin));
  const moduleGeo = new THREE.BoxGeometry(1.88, .98, .07);
  const moduleMaterial = new THREE.MeshPhysicalMaterial({ map: makeModuleTexture(), metalness: .32, roughness: .39, clearcoat: .25, clearcoatRoughness: .28, color: '#e7f1f6' });
  const legGeo = new THREE.CylinderGeometry(.095, .12, 1, 7); legGeo.rotateX(Math.PI / 2);
  const legMaterial = new THREE.MeshStandardMaterial({ color: '#a6aba5', metalness: .68, roughness: .47 });
  const beams = [], modules = [], legs = [];
  const dummy = new THREE.Object3D();
  frames.forEach((frame, rowIndex) => {
    const { center, along, across, length, width } = frame;
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...along, 0), new THREE.Vector3(...across, 0), new THREE.Vector3(0, 0, 1));
    const rotation = new THREE.Quaternion().setFromRotationMatrix(basis);
    const panelHeight = (x, y, cross = 0) => planes ? planes[rowIndex][0] * x + planes[rowIndex][1] * y + planes[rowIndex][2] : terrainHeight(site, x, y) + 3.4 + cross * .04;
    if (modelPanels) {
      const countAlong = Math.floor(length / 1.94), countAcross = Math.max(1, Math.floor(width / 1.03));
      for (let a = 0; a < countAlong; a++) for (let b = 0; b < countAcross; b++) {
        const s = (a - (countAlong - 1) / 2) * 1.94, t = (b - (countAcross - 1) / 2) * 1.03;
        const x = center[0] + along[0] * s + across[0] * t, y = center[1] + along[1] * s + across[1] * t;
        dummy.position.set(x, y, panelHeight(x, y, t)); dummy.quaternion.copy(rotation); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); modules.push(dummy.matrix.clone());
      }
    }
    const supports = Math.ceil(length / 8);
    for (let i = 0; i <= supports; i++) for (const acrossFactor of [-.37, .37]) {
      const s = -length / 2 + length * i / supports, t = width * acrossFactor;
      const x = center[0] + along[0] * s + across[0] * t, y = center[1] + along[1] * s + across[1] * t;
      const ground = terrainHeight(site, x, y), roof = panelHeight(x, y, t) - .13;
      const h = Math.max(.5, Math.min(6, roof - ground));
      dummy.position.set(x, y, roof - h / 2); dummy.quaternion.identity(); dummy.scale.set(1, 1, h); dummy.updateMatrix(); legs.push(dummy.matrix.clone());
    }
    for (let i = 0; i < supports; i++) for (const t of [-width * .37, width * .37]) {
      const s = -length / 2 + length * (i + .5) / supports;
      const x = center[0] + along[0] * s + across[0] * t, y = center[1] + along[1] * s + across[1] * t;
      dummy.position.set(x, y, panelHeight(x, y, t) - .15); dummy.quaternion.copy(rotation); dummy.scale.set(length / supports, .1, .14); dummy.updateMatrix(); beams.push(dummy.matrix.clone());
    }
  });
  function addInstances(geometry, material, matrices) {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix)); mesh.castShadow = true; mesh.receiveShadow = true; mesh.computeBoundingSphere(); group.add(mesh);
  }
  if (modules.length) addInstances(moduleGeo, moduleMaterial, modules);
  addInstances(legGeo, legMaterial, legs); addInstances(new THREE.BoxGeometry(1, 1, 1), legMaterial, beams);
  group.userData = { rows: frames.length, moduleCount: modules.length, supportCount: legs.length, modeled: modelPanels };
  return group;
}

function makeLandscape() {
  const group = new THREE.Group();
  const crownGeometry = new THREE.IcosahedronGeometry(1, 2);
  const pos = crownGeometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const noise = 1 + .09 * Math.sin(x * 17 + y * 11) * Math.cos(z * 19 - x * 7);
    pos.setXYZ(i, x * noise, y * noise, z * noise);
  }
  crownGeometry.computeVertexNormals();
  const crownMaterial = new THREE.MeshStandardMaterial({ color: '#fff', roughness: 1, flatShading: false });
  const crownCount = site.trees.length * 7;
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, crownCount);
  const trunkGeo = new THREE.CylinderGeometry(.13, .25, 1, 7); trunkGeo.rotateX(Math.PI / 2);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#71634c', roughness: 1 }), site.trees.length);
  const dummy = new THREE.Object3D(), palette = ['#566446', '#64704a', '#526047', '#6b714c', '#707653'];
  site.trees.forEach(([x, y, , radius], index) => {
    const ground = terrainHeight(site, x, y), h = Math.max(3, radius * 1.55);
    dummy.position.set(x, y, ground + h * .36); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, h * .72); dummy.updateMatrix(); trunks.setMatrixAt(index, dummy.matrix);
    for (let j = 0; j < 7; j++) {
      const angle = j * 2.399963 + index * .713, reach = j === 0 ? 0 : radius * .46;
      dummy.position.set(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach, ground + h * .72 + Math.sin(j * 1.7) * radius * .15);
      dummy.rotation.set(index * .37 + j, j * .2, angle); dummy.scale.set(radius * .7, radius * .64, radius * .62); dummy.updateMatrix();
      crowns.setMatrixAt(index * 7 + j, dummy.matrix); crowns.setColorAt(index * 7 + j, new THREE.Color(palette[(index + j) % palette.length]));
    }
  });
  crowns.castShadow = true; crowns.receiveShadow = true; trunks.castShadow = true;
  crowns.computeBoundingSphere(); trunks.computeBoundingSphere(); group.add(crowns, trunks); return group;
}

function createPerimeter() {
  const points = site.boundary.map(([x, y]) => {
    const lx = x - site.origin[0], ly = y - site.origin[1];
    return new THREE.Vector3(lx, ly, terrainHeight(site, lx, ly) + .5);
  });
  points.push(points[0].clone());
  const path = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 420, .32, 5, false), new THREE.MeshBasicMaterial({ color: '#67c8cf', transparent: true, opacity: .9, depthTest: false }));
  mesh.renderOrder = 5; mesh.visible = false; return mesh;
}

function label(text, target, kind = '') {
  const el = document.createElement('div'); el.className = `site-label ${kind}`; el.textContent = text; $('site-labels').append(el);
  labels.push({ el, target: new THREE.Vector3(...target) });
}
function updateLabels() {
  if (!site) return;
  const width = $('replica-view').clientWidth, height = $('replica-view').clientHeight;
  const dist = camera.position.distanceTo(controls.target);
  labels.forEach(({ el, target }) => {
    const p = target.clone().project(camera);
    const hidden = p.z > 1 || p.z < -1 || Math.abs(p.x) > .93 || Math.abs(p.y) > .82 || dist < 240;
    el.classList.toggle('hidden', hidden); el.style.left = `${(p.x * .5 + .5) * width}px`; el.style.top = `${(-p.y * .5 + .5) * height}px`;
  });
  const direction = camera.position.clone().sub(controls.target);
  $('replica-north-arrow').style.transform = `rotate(${Math.atan2(direction.x, -direction.y) * 180 / Math.PI}deg)`;
}

function desiredCamera(place, angle) {
  const bookmark = new THREE.Vector3(...site.bookmarks[place]);
  bookmark.z = terrainHeight(site, bookmark.x, bookmark.y) + (place === 'building' ? 12 : 3);
  const portrait = Math.max(1, .85 / camera.aspect);
  let offset;
  if (place === 'compound') offset = angle === 'top' ? new THREE.Vector3(0, -.1, 1050 * portrait) : new THREE.Vector3(530, -650, 740).multiplyScalar(portrait);
  else if (place === 'building') offset = angle === 'top' ? new THREE.Vector3(0, -.1, 460 * portrait) : new THREE.Vector3(115, -230, 170).multiplyScalar(portrait);
  else if (place === 'east') offset = angle === 'top' ? new THREE.Vector3(0, -.1, 550 * portrait) : new THREE.Vector3(-190, -150, 155).multiplyScalar(portrait);
  else offset = angle === 'top' ? new THREE.Vector3(0, -.1, 350 * portrait) : new THREE.Vector3(100, -140, 110).multiplyScalar(portrait);
  return { target: bookmark, position: bookmark.clone().add(offset) };
}

function goPlace(place, instant = false, angle = state.angle) {
  if (!controls || !site) return;
  const desired = desiredCamera(place, angle);
  state.place = place; state.angle = angle;
  document.querySelectorAll('[data-place]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.place === place)));
  document.querySelectorAll('[data-angle]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.angle === angle)));
  $('active-location').textContent = placeNames[place];
  $('active-location-detail').textContent = place === 'east' ? 'Registered camera inspection available' : place === 'south' ? 'Image-traced array · modelled modules' : 'University of Dubai';
  settingCamera = true;
  const damping = controls.enableDamping; controls.enableDamping = false; controls.update(); controls.enableDamping = damping;
  if (instant || reducedMotion.matches) {
    transition = null; state.transition = false; camera.position.copy(desired.position); controls.target.copy(desired.target); controls.update(); settingCamera = false; invalidate();
  } else {
    transition = { start: performance.now(), from: camera.position.clone(), fromTarget: controls.target.clone(), ...desired, duration: 850 }; state.transition = true;
  }
  if (window.innerWidth <= 700) setPanel(false, false);
}

async function setCapture(mode) {
  if (!state.ready) return;
  const sequence = ++captureSequence;
  if (mode !== 'normal' && state.place !== 'east') goPlace('east');
  state.pendingCapture = mode;
  $('replica-status').textContent = mode === 'normal' ? 'Campus ready' : `Loading ${mode} capture`;
  try {
    if (mode !== 'normal') {
      const key = { wide: 'wide_angle_1', thermal: 'thermal_1', zoom: 'zoom_1' }[mode];
      const registration = site.registration[key], tex = registration.texture;
      if (!textureCache.has(mode)) {
        state.textureLoads++;
        textureCache.set(mode, new THREE.TextureLoader().loadAsync(asset(tex.image)).then(texture => {
          texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true; return texture;
        }).catch(error => { textureCache.delete(mode); throw error; }));
      }
      const texture = await textureCache.get(mode);
      if (sequence !== captureSequence) return;
      const inv = inverseAffine(registration.sourceToReferenceLocal);
      captureUniforms.uReferenceToSource.value.set(...inv.flat());
      // Keep all shader arithmetic near the local origin to avoid metre-scale
      // float precision loss in multi-million-metre UTM northings.
      captureUniforms.uCaptureExtent.value.set(tex.xmin-site.origin[0], tex.ymax-site.origin[1], tex.pixelX * tex.width, tex.pixelY * tex.height);
      captureUniforms.uCaptureMap.value = texture;
    }
    if (sequence !== captureSequence) return;
    state.capture = mode; state.pendingCapture = null;
    captureUniforms.uCaptureMode.value = { normal: 0, wide: 1, thermal: 2, zoom: 3 }[mode];
    document.querySelectorAll('[data-capture]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.capture === mode)));
    $('capture-description').textContent = descriptions[mode]; $('thermal-note').hidden = mode !== 'thermal';
    $('capture-badge').hidden = mode === 'normal'; $('capture-badge').classList.toggle('thermal', mode === 'thermal');
    $('capture-badge-code').textContent = mode[0].toUpperCase(); $('capture-badge-title').textContent = `${mode[0].toUpperCase()}${mode.slice(1)} camera`;
    $('replica-mode-status').textContent = mode === 'normal' ? 'Survey-informed campus reconstruction' : `${mode[0].toUpperCase()}${mode.slice(1)} · same eastern surface`;
    $('replica-status').textContent = 'Campus ready'; invalidate();
  } catch (error) {
    if (sequence !== captureSequence) return;
    state.pendingCapture = null;
    $('replica-status').textContent = 'Capture unavailable'; toast(`The ${mode} capture could not load. The previous view is preserved; try again.`); console.warn(error);
  }
}

function setLighting(value) {
  const settings = {
    daylight: { position: [-230, -450, 750], sun: 2.6, ambient: 1.7, exposure: 1.03, color: '#fff4dd' },
    afternoon: { position: [-600, -210, 250], sun: 3.0, ambient: 1.3, exposure: 1.02, color: '#ffdbab' },
    soft: { position: [-200, -200, 800], sun: .65, ambient: 2.8, exposure: 1.06, color: '#f0f6ff' },
  }[value];
  sun.position.set(...settings.position); sun.intensity = settings.sun; sun.color.set(settings.color); hemi.intensity = settings.ambient;
  renderer.toneMappingExposure = settings.exposure; renderer.shadowMap.needsUpdate = true; invalidate();
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  if (transition) {
    const t = Math.min(1, (now - transition.start) / transition.duration), ease = t === 1 ? 1 : 1 - 2 ** (-10 * t);
    camera.position.lerpVectors(transition.from, transition.position, ease); controls.target.lerpVectors(transition.fromTarget, transition.target, ease);
    if (t === 1) { transition = null; state.transition = false; settingCamera = false; }
    dirty = true;
  }
  controls.update();
  if (dirty) { renderer.render(scene, camera); updateLabels(); dirty = false; }
}

async function init() {
  try {
    const response = await fetch(asset('site.json'));
    if (!response.ok) throw new Error(`Site metadata HTTP ${response.status}`);
    site = await response.json();
    scene = new THREE.Scene(); scene.background = new THREE.Color('#dce5e2'); scene.fog = new THREE.Fog('#dce5e2', 1600, 5000);
    camera = new THREE.PerspectiveCamera(43, 1, 1, 12000); camera.up.set(0, 0, 1);
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.03;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
    $('replica-view').append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .13;
    controls.minDistance = 5; controls.maxDistance = 2400; controls.maxPolarAngle = Math.PI * .475; controls.screenSpacePanning = false; controls.zoomToCursor = true;
    controls.addEventListener('change', invalidate);
    controls.addEventListener('start', () => { transition = null; state.transition = false; settingCamera = false; });
    hemi = new THREE.HemisphereLight('#e4f1ff', '#99805a', 1.7); hemi.position.set(0, 0, 1); scene.add(hemi);
    sun = new THREE.DirectionalLight('#fff4dd', 2.6); sun.position.set(-230, -450, 750); sun.target.position.set(25, -10, 0);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -600; sun.shadow.camera.right = 600; sun.shadow.camera.top = 650; sun.shadow.camera.bottom = -650; sun.shadow.camera.near = 100; sun.shadow.camera.far = 2000; sun.shadow.normalBias = .16; sun.shadow.bias = -.00015; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    const outerGeometry = new THREE.PlaneGeometry(16000, 16000, 1, 1);
    const op = outerGeometry.attributes.position;
    for (let i = 0; i < op.count; i++) op.setZ(i, terrainHeight(site, op.getX(i), op.getY(i)) - .35);
    outerGeometry.computeVertexNormals();
    const outer = new THREE.Mesh(outerGeometry, new THREE.MeshStandardMaterial({ color: '#bbad8b', roughness: 1 })); outer.receiveShadow = true; scene.add(outer);
    resize(); goPlace('compound', true); requestAnimationFrame(frame);
    const loader = new GLTFLoader(); let completed = 0;
    const load = async (file, label) => {
      const gltf = await loader.loadAsync(asset(file), event => { if (event.total) progress(12 + completed * 26 + event.loaded / event.total * 24, label); });
      completed++; return gltf.scene;
    };
    [terrain, building, eastSurface, facades] = await Promise.all([load('terrain.glb', 'Preparing the full compound terrain…'), load('campus-surfaces.glb', 'Reconstructing the university roof forms…'), load('east-surface.glb', 'Aligning the eastern solar array…'), load('campus-facades.glb', 'Building facades and covered parking…')]);
    terrain.name = 'Georeferenced compound terrain'; building.name = 'LiDAR-derived university surfaces'; eastSurface.name = 'Shared registered eastern surface';
    modelMaterial(terrain); modelMaterial(building); modelMaterial(eastSurface); modelMaterial(facades,{roughness:.55,metalness:.05});
    terrain.traverse(object => {
      if (!object.isMesh) return;
      object.castShadow = false;
      object.material.transparent = true;
      object.material.depthWrite = false;
      object.material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\ndiffuseColor.a *= smoothstep(0.0,0.075,min(min(vMapUv.x,1.0-vMapUv.x),min(vMapUv.y,1.0-vMapUv.y)));');
      };
      object.material.needsUpdate = true;
    });
    configureEastMaterial();
    landscape = makeLandscape(); landscape.name = 'Image-positioned modelled landscape';
    southArray = makeSolarArray(site.southRows, true); southArray.name = 'South solar array';
    eastSupports = makeSolarArray(site.eastRows, false, site.eastRowPlanes); eastSupports.name = 'East solar supports';
    parkingSupports = makeSolarArray(site.coveredParking.map(e=>e.points), false, site.coveredParking.map(e=>[0,0,e.z-site.origin[2]])); parkingSupports.name = 'Covered parking supports';
    perimeter = createPerimeter(); perimeter.name = 'Image-traced compound perimeter';
    scene.add(terrain, building, facades, eastSurface, landscape, southArray, eastSupports, parkingSupports, perimeter);
    state.geometries = { terrain: terrain.uuid, building: building.uuid, east: eastSurface.uuid, south: southArray.uuid };
    label('University of Dubai', [-25, -155, 40]);
    const eastCenter = site.bookmarks.east; label('East solar array', [eastCenter[0], eastCenter[1], 14], 'solar');
    const southCenter = site.bookmarks.south; label('South solar array', [southCenter[0], southCenter[1], 16], 'solar');
    state.ready = true;
    for (const id of ['place-controls', 'capture-controls', 'replica-display']) $(id).disabled = false;
    $('replica-loading').hidden = true; $('replica-status').textContent = 'Campus ready'; $('replica-status-dot').className = 'status-dot ready';
    renderer.shadowMap.needsUpdate = true; invalidate();
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('WebGL context lost')); });
    window.uodReplica = { state, scene, camera, controls, renderer, site, terrain, building, facades, parkingSupports, eastSurface, southArray, landscape, perimeter, captureUniforms, goPlace, setCapture };
  } catch (error) { fail(error); }
}

function resize() {
  if (!renderer) return;
  const { width, height } = $('replica-view').getBoundingClientRect();
  renderer.setSize(width, height); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix(); invalidate();
}
const resizeObserver = new ResizeObserver(() => {
  resize(); clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.ready && !settingCamera) goPlace(state.place, true); }, 150);
});
resizeObserver.observe($('replica-view'));

function setPanel(open, focus = true) {
  $('replica-sidebar').classList.toggle('open', open); $('replica-backdrop').hidden = !open;
  $('replica-open').setAttribute('aria-expanded', String(open));
  $('replica-sidebar').inert = !open && innerWidth <= 700;
  if (focus) (open ? $('replica-close') : $('replica-open')).focus();
}
function setHelp(open) {
  $('replica-help-panel').hidden = !open; $('replica-help').setAttribute('aria-expanded', String(open));
  (open ? $('replica-help-close') : $('replica-help')).focus();
}
const narrow = matchMedia('(max-width:700px)');
function panelAccessibility() {
  $('replica-sidebar').inert = narrow.matches && !$('replica-sidebar').classList.contains('open');
  if (!narrow.matches) { $('replica-sidebar').classList.remove('open'); $('replica-backdrop').hidden = true; $('replica-open').setAttribute('aria-expanded', 'false'); }
}
narrow.addEventListener('change', panelAccessibility); panelAccessibility();
$('replica-open').addEventListener('click', () => setPanel(true)); $('replica-close').addEventListener('click', () => setPanel(false)); $('replica-backdrop').addEventListener('click', () => setPanel(false));
$('replica-help').addEventListener('click', () => setHelp($('replica-help-panel').hidden)); $('replica-help-close').addEventListener('click', () => setHelp(false));
document.querySelectorAll('[data-place]').forEach(button => button.addEventListener('click', () => goPlace(button.dataset.place)));
document.querySelectorAll('[data-angle]').forEach(button => button.addEventListener('click', () => goPlace(state.place, false, button.dataset.angle)));
document.querySelectorAll('[data-capture]').forEach(button => button.addEventListener('click', () => setCapture(button.dataset.capture)));
$('replica-reset').addEventListener('click', () => goPlace('compound', false, 'perspective'));
$('replica-retry').addEventListener('click', () => location.reload());
$('landscape-toggle').addEventListener('change', event => { landscape.visible = event.target.checked; renderer.shadowMap.needsUpdate = true; invalidate(); });
$('perimeter-toggle').addEventListener('change', event => { perimeter.visible = event.target.checked; invalidate(); });
$('lighting-select').addEventListener('change', event => setLighting(event.target.value));
$('replica-fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('replica-scene').requestFullscreen(); }
  catch { toast('Full screen is unavailable in this browser.'); }
});
document.addEventListener('fullscreenchange', () => $('replica-fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Enter full screen'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (!$('replica-help-panel').hidden) setHelp(false); if ($('replica-sidebar').classList.contains('open')) setPanel(false); }
  if (event.key === 'Tab' && narrow.matches && $('replica-sidebar').classList.contains('open')) {
    const items = [...$('replica-sidebar').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a')].filter(el => el.getClientRects().length);
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (state.ready && event.key.toLowerCase() === 'r') goPlace('compound', false, 'perspective');
  if (state.ready && event.key.toLowerCase() === 't') goPlace(state.place, false, 'top');
});
window.addEventListener('pagehide', () => { resizeObserver.disconnect(); clearTimeout(resizeTimer); clearTimeout(toastTimer); controls?.dispose(); renderer?.dispose(); });
init();
