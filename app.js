'use strict';

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;
const CSS_DPI = 96;               // reference dpi: labels print at their on-screen physical size
const EARTH_CIRC = 40075016.686;  // metres at the equator

const STYLES = {
  liberty:  'https://tiles.openfreemap.org/styles/liberty',
  bright:   'https://tiles.openfreemap.org/styles/bright',
  positron: 'https://tiles.openfreemap.org/styles/positron',
};

// borderless formats are print-shop posters: no unprintable printer margins
const PAGE_FORMATS = {
  portrait:       { pageW: 210,  pageH: 297,  landscape: false, borderless: false, label: 'A4 portrait' },
  landscape:      { pageW: 297,  pageH: 210,  landscape: true,  borderless: false, label: 'A4 landscape' },
  largePortrait:  { pageW: 1000, pageH: 1500, landscape: false, borderless: true,  label: '100 × 150 cm poster' },
  largeLandscape: { pageW: 1500, pageH: 1000, landscape: true,  borderless: true,  label: '150 × 100 cm poster' },
};

const CATEGORIES = [
  ['water',      'Water (rivers, lakes…)'],
  ['green',      'Greenery (parks, woods…)'],
  ['buildings',  'Buildings'],
  ['roads',      'Roads & paths'],
  ['rail',       'Rail & transit'],
  ['landuse',    'Land use tint'],
  ['boundaries', 'Boundaries'],
  ['labels',     'Place & POI labels'],
  ['other',      'Everything else'],
];

let map;
let layerCategory = {};   // style layer id -> category key
let lockedNW = null;      // LngLat of print-area corners while locked,
let lockedSE = null;      // null = frame follows the screen
let hoverTile = null;     // {r, c} under the cursor while locked
let wallOff = { x: 0, y: 0 };  // wall outline offset within the covered area (mm)
let dragWall = null;      // {mx, my, ox, oy, k} while the outline is dragged
let wallLabelBox = null;  // screen-px rect of the wall label badge (drag handle)

/* ---------------------------------------------------------------- params */

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

// All lengths in mm unless noted otherwise.
function params() {
  const wallW = num('wallW', 180) * 10;
  const wallH = num('wallH', 250) * 10;
  const fmt = PAGE_FORMATS[$('orient').value] || PAGE_FORMATS.portrait;
  const { pageW, pageH, landscape, borderless } = fmt;
  const m = borderless
    ? { t: 0, r: 0, b: 0, l: 0 }
    : { t: num('mTop', 5), r: num('mRight', 5), b: num('mBottom', 5), l: num('mLeft', 5) };
  const overlap = Math.max(0, num('overlap', 6));
  const pw = pageW - m.l - m.r;   // printable width per page
  const ph = pageH - m.t - m.b;
  const sx = pw - overlap;        // horizontal step between page contents
  const sy = ph - overlap;
  if (pw <= 20 || ph <= 20) return { error: 'Printer margins leave no printable area.' };
  if (sx <= 0 || sy <= 0) return { error: 'Overlap is larger than the printable page.' };
  const cols = Math.max(1, Math.ceil((wallW - overlap) / sx));
  const rows = Math.max(1, Math.ceil((wallH - overlap) / sy));
  const coveredW = (cols - 1) * sx + pw;  // assembled size, may slightly exceed the wall
  const coveredH = (rows - 1) * sy + ph;
  return { wallW, wallH, landscape, borderless, pageLabel: fmt.label,
           pageW, pageH, m, overlap, pw, ph, sx, sy, cols, rows, coveredW, coveredH };
}

let _maxPx = 0;
function maxRenderPx() {
  if (_maxPx) return _maxPx;
  let px = 4096;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    px = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
  } catch (e) { /* keep conservative default */ }
  _maxPx = Math.min(px, 9000);   // memory guard
  return _maxPx;
}

// Target print resolution. Each page is rendered in GPU-canvas-sized passes
// stitched on a 2D canvas, so the GPU limit does not cap the dpi; the 2D
// canvas holding one full page does. Browsers differ a lot here (Chromium
// allows ~268M px², Firefox ~125M), so probe the real limit once instead of
// assuming the cross-browser minimum.
const DPI_TARGET = 300;
let _cvLim = null;
function canvasLimits() {
  if (_cvLim) return _cvLim;
  const test = (w, h) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    let ok = false;
    try {
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(w - 1, h - 1, 1, 1);
      ok = ctx.getImageData(w - 1, h - 1, 1, 1).data[3] !== 0;
    } catch (e) { /* over the limit */ }
    cv.width = cv.height = 0;   // release the buffer right away
    return ok;
  };
  const side = test(32767, 1) ? 32767 : 16384;
  let area = 120e6;             // every desktop browser handles this much
  for (const a of [268435456, 160e6]) {
    const s = Math.floor(Math.sqrt(a));
    if (test(s, s)) { area = s * s; break; }
  }
  _cvLim = { side, area };
  return _cvLim;
}
function exportDPI(p) {
  const { side, area } = canvasLimits();
  const wIn = p.pw / MM_PER_IN, hIn = p.ph / MM_PER_IN;
  return Math.min(DPI_TARGET, side / wIn, side / hIn, Math.sqrt(area / (wIn * hIn)));
}

// Extra map-zoom levels for the export. The style gates features by zoom
// (minor streets, house numbers, POIs only appear at higher zooms), so a
// large wall rendered at its physical-scale zoom looks empty per page.
// Each +1 doubles the feature-density zoom and halves the printed size of
// labels/line widths; the output dpi stays the same.
function detailBoost() {
  return parseInt($('detail').value, 10) || 0;
}

/* ------------------------------------------------------- frame + overlay */

// Fixed on-screen frame with the assembled-map aspect ratio; the map pans
// underneath it. Everything inside the frame ends up on paper.
function frameRect(p) {
  const el = $('map');
  const W = el.clientWidth, H = el.clientHeight, pad = 46;
  const k = Math.min((W - 2 * pad) / p.coveredW, (H - 2 * pad) / p.coveredH);
  return { x: (W - p.coveredW * k) / 2, y: (H - p.coveredH * k) / 2, w: p.coveredW * k, h: p.coveredH * k, k };
}

// Geographic corners of the print area. While locked these are pinned to the
// map; the SE corner is re-derived from the paper aspect ratio so that
// changing wall/page settings keeps the area consistent.
function areaBounds(p) {
  if (lockedNW) {
    const a = maplibregl.MercatorCoordinate.fromLngLat(lockedNW);
    const b = maplibregl.MercatorCoordinate.fromLngLat(lockedSE);
    const y2 = a.y + (b.x - a.x) * p.coveredH / p.coveredW;
    return { nw: lockedNW, se: new maplibregl.MercatorCoordinate(b.x, y2, 0).toLngLat() };
  }
  const f = frameRect(p);
  return { nw: map.unproject([f.x, f.y]), se: map.unproject([f.x + f.w, f.y + f.h]) };
}

// Screen-pixel rectangle of the print area (projected when locked).
function viewRect(p) {
  if (lockedNW) {
    const { nw, se } = areaBounds(p);
    const a = map.project(nw), b = map.project(se);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, k: (b.x - a.x) / p.coveredW };
  }
  return frameRect(p);
}

// Page tile under a #mapwrap-relative point; overlap strips count as the
// right/bottom neighbour (whose content starts there).
function tileAt(mx, my) {
  const p = params();
  if (p.error) return null;
  const f = viewRect(p);
  const x = (mx - f.x) / f.k, y = (my - f.y) / f.k;   // mm within the covered area
  if (x < 0 || y < 0 || x > p.coveredW || y > p.coveredH) return null;
  return {
    r: Math.min(p.rows - 1, Math.floor(y / p.sy)),
    c: Math.min(p.cols - 1, Math.floor(x / p.sx)),
  };
}

// True when a #mapwrap-relative point can start a drag of the wall outline:
// on the label badge, or on the outline's edge (within ±7 px).
function onWallEdge(mx, my) {
  const p = params();
  if (p.error) return false;
  if (p.coveredW - p.wallW < 0.5 && p.coveredH - p.wallH < 0.5) return false;
  const b = wallLabelBox;
  if (b && mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) return true;
  const f = viewRect(p);
  const x = f.x + wallOff.x * f.k, y = f.y + wallOff.y * f.k;
  const w = p.wallW * f.k, h = p.wallH * f.k, near = 7;
  const inOuter = mx >= x - near && mx <= x + w + near && my >= y - near && my <= y + h + near;
  const inInner = mx > x + near && mx < x + w - near && my > y + near && my < y + h - near;
  return inOuter && !inInner;
}

function drawOverlay() {
  const cv = $('overlay'), el = $('map');
  const W = el.clientWidth, H = el.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const p = params();
  if (p.error) return;
  const f = viewRect(p);

  ctx.fillStyle = lockedNW ? 'rgba(15,18,24,.25)' : 'rgba(15,18,24,.45)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(f.x, f.y, f.w, f.h);
  ctx.fill('evenodd');

  ctx.fillStyle = 'rgba(255,140,0,.18)';
  for (let c = 1; c < p.cols; c++) ctx.fillRect(f.x + c * p.sx * f.k, f.y, p.overlap * f.k, f.h);
  for (let r = 1; r < p.rows; r++) ctx.fillRect(f.x, f.y + r * p.sy * f.k, f.w, p.overlap * f.k);

  ctx.strokeStyle = 'rgba(255,140,0,.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < p.cols; c++) {
    const x = f.x + c * p.sx * f.k;
    ctx.moveTo(x, f.y); ctx.lineTo(x, f.y + f.h);
  }
  for (let r = 1; r < p.rows; r++) {
    const y = f.y + r * p.sy * f.k;
    ctx.moveTo(f.x, y); ctx.lineTo(f.x + f.w, y);
  }
  ctx.stroke();

  ctx.strokeStyle = lockedNW ? '#3ad67e' : '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(f.x, f.y, f.w, f.h);

  // dashed outline of the requested wall size — the assembled sheets can
  // overhang it (page count is rounded up); drag the edge or the label
  // badge to choose where the overhang goes
  wallLabelBox = null;
  if (p.wallW < p.coveredW - 0.5 || p.wallH < p.coveredH - 0.5) {
    wallOff.x = Math.min(Math.max(0, wallOff.x), p.coveredW - p.wallW);
    wallOff.y = Math.min(Math.max(0, wallOff.y), p.coveredH - p.wallH);
    const wx = f.x + wallOff.x * f.k, wy = f.y + wallOff.y * f.k;
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(wx, wy, p.wallW * f.k, p.wallH * f.k);
    ctx.setLineDash([]);

    // label badge = drag handle, clamped into the viewport so it stays
    // reachable when the outline extends off screen
    const txt = `↔↕ wall ${p.wallW / 10} × ${p.wallH / 10} cm`;
    ctx.font = '600 12px system-ui, sans-serif';
    const bw = ctx.measureText(txt).width + 14, bh = 22;
    const bx = Math.min(Math.max(wx + 6, 6), W - bw - 6);
    const by = Math.min(Math.max(wy + p.wallH * f.k - bh - 6, 6), H - bh - 6);
    wallLabelBox = { x: bx, y: by, w: bw, h: bh };
    ctx.fillStyle = 'rgba(29,111,209,.92)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + 7, by + bh / 2 + 1);
  }

  if (lockedNW && hoverTile) {
    const tx = f.x + hoverTile.c * p.sx * f.k;
    const ty = f.y + hoverTile.r * p.sy * f.k;
    ctx.fillStyle = 'rgba(58,214,126,.10)';
    ctx.fillRect(tx, ty, p.pw * f.k, p.ph * f.k);
    ctx.strokeStyle = '#3ad67e';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx, ty, p.pw * f.k, p.ph * f.k);

    // R/C badge in the tile's top-left corner, clamped into the viewport
    const txt = `R${hoverTile.r + 1} C${hoverTile.c + 1}`;
    ctx.font = '600 13px system-ui, sans-serif';
    const bw = ctx.measureText(txt).width + 12, bh = 20;
    const bx = Math.min(Math.max(tx + 5, 5), W - bw - 5);
    const by = Math.min(Math.max(ty + 5, 5), H - bh - 5);
    ctx.fillStyle = 'rgba(15,18,24,.85)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#3ad67e';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + 6, by + bh / 2 + 1);
  }
}

function updateInfo() {
  const p = params();
  if (p.error) {
    $('info').textContent = p.error;
    $('exportBtn').disabled = true;
    return;
  }
  $('exportBtn').disabled = false;
  const lines = [];
  lines.push(`Pages: ${p.cols} × ${p.rows} = <b>${p.cols * p.rows}</b> (${p.pageLabel})`);
  lines.push(`Assembled: <b>${(p.coveredW / 10).toFixed(1)} × ${(p.coveredH / 10).toFixed(1)} cm</b>` +
             ` (wall ${p.wallW / 10} × ${p.wallH / 10})`);
  if (map) {
    const { nw, se } = areaBounds(p);
    const midLat = (nw.lat + se.lat) / 2;
    const metres = (se.lng - nw.lng) / 360 * EARTH_CIRC * Math.cos(midLat * Math.PI / 180);
    if (metres > 0) {
      lines.push(`Map width: ${(metres / 1000).toFixed(2)} km — scale ≈ <b>1 : ${Math.round(metres / (p.coveredW / 1000)).toLocaleString('en')}</b>`);
      const cssW = p.coveredW / MM_PER_IN * CSS_DPI;
      const zPrint = Math.log2(cssW / (512 * (se.lng - nw.lng) / 360)) + detailBoost();
      lines.push(`Print ≈ <b>${Math.round(exportDPI(p))} dpi</b>, map zoom <b>${zPrint.toFixed(1)}</b> (screen ${map.getZoom().toFixed(1)})`);
      if (lockedNW) lines.push('<b style="color:#3ad67e">Area locked</b> — pan/zoom freely to inspect; hover a tile for its page (R C).');
    }
  }
  if (p.cols * p.rows > 120) lines.push('<b>⚠ over 120 pages</b> — is that intended?');
  $('info').innerHTML = lines.join('<br>');
}

function refresh() {
  const borderless = (PAGE_FORMATS[$('orient').value] || PAGE_FORMATS.portrait).borderless;
  for (const id of ['mTop', 'mRight', 'mBottom', 'mLeft']) $(id).disabled = borderless;
  $('largeHint').style.display = borderless ? '' : 'none';
  drawOverlay();
  updateInfo();
}

/* ---------------------------------------------------------- categories */

function classify(layer) {
  if (layer.type === 'background') return null;  // always keep the paper colour
  const t = (layer.id + ' ' + (layer['source-layer'] || '')).toLowerCase();
  const sl = (layer['source-layer'] || '').toLowerCase();
  if (sl === 'water' || sl === 'waterway' || /water|ocean|river|lake|swimming|marina/.test(t)) return 'water';
  if (sl === 'park' || sl === 'landcover' || /park|wood|forest|grass|meadow|orchard|garden|cemet|golf|zoo|scrub|tree|vegetation|green/.test(t)) return 'green';
  if (sl === 'building' || /building|housenum/.test(t)) return 'buildings';
  if (/rail|transit|ferry|aerialway/.test(t)) return 'rail';
  if (sl.startsWith('transportation') || /road|highway|motorway|bridge|tunnel|street|path|track|aeroway|oneway/.test(t)) return 'roads';
  if (sl === 'landuse' || /landuse/.test(t)) return 'landuse';
  if (sl === 'boundary' || /boundary|admin/.test(t)) return 'boundaries';
  if (layer.type === 'symbol' || /label|place|poi|text|shield/.test(t)) return 'labels';
  return 'other';
}

function buildCategories() {
  layerCategory = {};
  for (const l of map.getStyle().layers) {
    const c = classify(l);
    if (c) layerCategory[l.id] = c;
  }
  applyVisibility(map);
}

function applyVisibility(m) {
  const on = {};
  for (const [key] of CATEGORIES) on[key] = $('cat_' + key).checked;
  for (const [id, cat] of Object.entries(layerCategory)) {
    if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', on[cat] ? 'visible' : 'none');
  }
  applyBikeLayer(m);
}

// Bike paths are not separate layers in the base styles (cycleways render as
// generic paths), so highlighting them means adding our own line layer over
// the OpenMapTiles `transportation` data.
function applyBikeLayer(m) {
  const id = 'bike-paths-highlight';
  const want = $('bikePaths').checked;
  if (!want) {
    if (m.getLayer(id)) m.removeLayer(id);
    return;
  }
  if (m.getLayer(id)) return;
  const layers = m.getStyle().layers;
  const source = layers.find((l) => l['source-layer'] === 'transportation')?.source;
  if (!source) return;
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;  // keep labels on top
  m.addLayer({
    id, type: 'line', source, 'source-layer': 'transportation',
    filter: ['any',
      ['==', ['get', 'subclass'], 'cycleway'],
      ['in', ['get', 'bicycle'], ['literal', ['yes', 'designated', '1']]],
    ],
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#9333ea',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2.5, 16, 4],
      'line-dasharray': [2, 1.5],
    },
  }, firstSymbol);
}

/* -------------------------------------------------------------- search */

async function doSearch() {
  const q = $('q').value.trim();
  if (!q) return;
  const ul = $('results');
  ul.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q));
    const hits = await r.json();
    ul.innerHTML = '';
    if (!hits.length) { ul.innerHTML = '<li class="muted">No results.</li>'; return; }
    for (const h of hits) {
      const li = document.createElement('li');
      li.textContent = h.display_name;
      li.onclick = () => {
        const [latMin, latMax, lonMin, lonMax] = h.boundingbox.map(Number);
        map.fitBounds([[lonMin, latMin], [lonMax, latMax]], { padding: 80, duration: 800 });
        ul.innerHTML = '';
      };
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = '<li class="muted">Search failed: ' + e.message + '</li>';
  }
}

/* -------------------------------------------------------------- export */

const once = (m, ev) => new Promise((res) => m.once(ev, res));
const raf = () => new Promise((res) => requestAnimationFrame(res));

async function exportPDF() {
  const p = params();
  if (p.error) return;
  const btn = $('exportBtn');
  const status = (t) => { $('status').textContent = t; };
  btn.disabled = true;
  let em = null, holder = null;
  try {
    const { nw, se } = areaBounds(p);
    const dpi = exportDPI(p);
    const boost = detailBoost();

    // One hidden map, re-centred for every render, so the resolution is
    // independent of the wall size. CSS pixel size fixes the physical size
    // of labels/line widths (`ref` dpi reference — 96 css dpi divided down
    // by the detail boost); pixelRatio raises the real resolution up to
    // `dpi`. A page larger than the GPU's maximum canvas is rendered in
    // nx × ny passes stitched together on the (2D) page canvas.
    const ref = CSS_DPI * 2 ** boost;
    const cssW = p.coveredW / MM_PER_IN * ref;       // assembled map in css px
    const zoom = Math.log2(cssW / (512 * (se.lng - nw.lng) / 360));
    const cap = maxRenderPx();
    const nx = Math.ceil(p.pw / MM_PER_IN * dpi / cap);
    const ny = Math.ceil(p.ph / MM_PER_IN * dpi / cap);
    const subW = p.pw / nx, subH = p.ph / ny;        // one render pass, in mm
    const subCssW = subW / MM_PER_IN * ref;
    const subCssH = subH / MM_PER_IN * ref;
    const c1 = maplibregl.MercatorCoordinate.fromLngLat(nw);
    const c2 = maplibregl.MercatorCoordinate.fromLngLat(se);
    // centre of a render, from mm offsets within the covered area
    const centerAt = (x, y) => new maplibregl.MercatorCoordinate(
      c1.x + (c2.x - c1.x) * x / p.coveredW,
      c1.y + (c2.y - c1.y) * y / p.coveredH, 0).toLngLat();

    status('Rendering map at print resolution — downloading tiles, this can take a minute…');
    holder = document.createElement('div');
    holder.style.cssText = `position:fixed;top:0;left:-${Math.ceil(subCssW) + 100}px;width:${subCssW}px;height:${subCssH}px;`;
    document.body.appendChild(holder);
    em = new maplibregl.Map({
      container: holder,
      style: STYLES[$('style').value],
      center: centerAt(subW / 2, subH / 2), zoom,
      bearing: 0, pitch: 0,
      interactive: false,
      attributionControl: false,
      pixelRatio: dpi / ref,
      // maplibre's default maxCanvasSize is [4096, 4096] and silently
      // *lowers the pixel ratio* to fit — which capped exports at ~140 dpi.
      // Lift it to the GPU limit; render passes are sized to fit `cap`.
      maxCanvasSize: [cap, cap],
      preserveDrawingBuffer: true,
      fadeDuration: 0,
      maxZoom: 24,
    });
    await once(em, 'load');
    applyVisibility(em);
    await once(em, 'idle');

    const outFmt = $('outFmt').value;   // 'pdf' | 'jpeg' | 'png'
    const { jsPDF } = window.jspdf;
    const orientation = p.landscape ? 'landscape' : 'portrait';
    // the cover sheet is always A4 (it's meant for a home printer);
    // map pages are added at the selected format's real size
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation, compress: true });
    coverPage(pdf, p, { nw, se, dpi, zoom }, outFmt === 'pdf');

    const total = p.cols * p.rows;
    const pageCv = document.createElement('canvas');
    const ctx = pageCv.getContext('2d');
    let n = 0;
    for (let r = 0; r < p.rows; r++) {
      for (let c = 0; c < p.cols; c++) {
        n++;
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const part = nx * ny > 1 ? ` (part ${iy * nx + ix + 1}/${nx * ny})` : '';
            status(`Rendering page ${n} / ${total}${part}…`);
            em.jumpTo({ center: centerAt(c * p.sx + (ix + .5) * subW, r * p.sy + (iy + .5) * subH) });
            await once(em, 'idle');
            await raf();
            const src = em.getCanvas();
            if (!ix && !iy) { pageCv.width = nx * src.width; pageCv.height = ny * src.height; }
            ctx.drawImage(src, ix * src.width, iy * src.height);
          }
        }
        const ppm = pageCv.width / p.pw;  // rendered pixels per mm
        if ($('wallGrid').checked) drawWallGrid(ctx, pageCv, p, r, c);
        if ($('pageLabels').checked) drawPageLabel(ctx, pageCv, `R${r + 1} C${c + 1}`, ppm);
        if (outFmt === 'pdf') {
          pdf.addPage([p.pageW, p.pageH], orientation);
          pdf.addImage(pageCv.toDataURL('image/jpeg', 0.95), 'JPEG', p.m.l, p.m.t, p.pw, p.ph);
        } else {
          status(`Saving page ${n} / ${total}…`);
          await savePageImage(pageCv, `wall-map-R${r + 1}C${c + 1}.${outFmt === 'png' ? 'png' : 'jpg'}`, outFmt);
        }
      }
    }
    // measured from the last page canvas — catches any silent downscale
    const realDpi = Math.round(pageCv.width / (p.pw / MM_PER_IN));
    if (outFmt === 'pdf') {
      pdf.save('wall-map.pdf');
      status(`Done — ${total} map pages at ${realDpi} dpi + cover sheet.`);
    } else {
      pdf.save('wall-map-cover.pdf');
      status(`Done — ${total} ${outFmt.toUpperCase()} pages at ${realDpi} dpi + cover PDF. ` +
             'If the browser asks, allow multiple downloads.');
    }
  } catch (e) {
    status('Export failed: ' + e.message);
    console.error(e);
  } finally {
    if (em) em.remove();
    if (holder) holder.remove();
    btn.disabled = false;
  }
}

// 10 × 10 cm grid in printed (wall) size, aligned to the covered-area origin
// so the lines continue seamlessly across sheets.
function drawWallGrid(ctx, cv, p, r, c) {
  const pxmX = cv.width / p.pw, pxmY = cv.height / p.ph;  // px per mm
  const step = 100;                                       // mm
  const x0 = c * p.sx, y0 = r * p.sy;  // page origin within the covered area
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.lineWidth = Math.max(1, 0.15 * pxmX);   // ≈0.15 mm hairline
  ctx.beginPath();
  for (let g = Math.ceil(x0 / step) * step; g <= x0 + p.pw; g += step) {
    const x = (g - x0) * pxmX;
    ctx.moveTo(x, 0); ctx.lineTo(x, cv.height);
  }
  for (let g = Math.ceil(y0 / step) * step; g <= y0 + p.ph; g += step) {
    const y = (g - y0) * pxmY;
    ctx.moveTo(0, y); ctx.lineTo(cv.width, y);
  }
  ctx.stroke();
}

function savePageImage(cv, name, fmt) {
  return new Promise((resolve, reject) => {
    cv.toBlob((blob) => {
      if (!blob) return reject(new Error('page too large to encode as ' + fmt.toUpperCase()));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      // give the browser a moment to pick the blob up before revoking
      setTimeout(() => { URL.revokeObjectURL(a.href); resolve(); }, 500);
    }, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95);
  });
}

// Sits inside the bottom-right overlap corner, so it is glued over by the
// right/lower neighbour; only the very last sheet keeps a visible label.
function drawPageLabel(ctx, cv, txt, ppm) {
  const fs = Math.max(8, 3 * ppm);
  ctx.font = `${fs}px sans-serif`;
  const w = ctx.measureText(txt).width;
  const pad = ppm;
  const x = cv.width - w - 2 * pad - 1.5 * ppm;
  const y = cv.height - fs - 2 * pad - 1.5 * ppm;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillRect(x, y, w + 2 * pad, fs + 2 * pad);
  ctx.fillStyle = '#666';
  ctx.textBaseline = 'top';
  ctx.fillText(txt, x + pad, y + pad);
}

// withLinks: map pages follow the cover in the same PDF; false when the
// pages are exported as separate image files and there is nothing to link to
function coverPage(pdf, p, x, withLinks = true) {
  const midLat = (x.nw.lat + x.se.lat) / 2;
  const metres = (x.se.lng - x.nw.lng) / 360 * EARTH_CIRC * Math.cos(midLat * Math.PI / 180);
  const scale = Math.round(metres / (p.coveredW / 1000));

  pdf.setFont('helvetica', 'bold').setFontSize(20);
  pdf.text('Wall map', 15, 20);
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const meta = [
    `Pages: ${p.cols} × ${p.rows} = ${p.cols * p.rows} (${p.pageLabel})`,
    `Assembled size: ${(p.coveredW / 10).toFixed(1)} × ${(p.coveredH / 10).toFixed(1)} cm  (wall: ${p.wallW / 10} × ${p.wallH / 10} cm)`,
    `Scale ≈ 1 : ${scale.toLocaleString('en')}   ·   ${(metres / 1000).toFixed(2)} km wide`,
    `Render: ${Math.round(x.dpi)} dpi at map zoom ${x.zoom.toFixed(1)}   ·   printer margins T/R/B/L: ${p.m.t}/${p.m.r}/${p.m.b}/${p.m.l} mm   ·   overlap: ${p.overlap} mm`,
    `Generated ${new Date().toISOString().slice(0, 10)}   ·   Map data © OpenStreetMap contributors, tiles by OpenFreeMap`,
  ];
  let y = 30;
  for (const line of meta) { pdf.text(line, 15, y); y += 5.5; }

  pdf.setFont('helvetica', 'bold').setFontSize(12);
  y += 4; pdf.text('Assembly', 15, y); y += 6;
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const steps = p.borderless ? [
    `1. Have every page printed at exactly ${p.pageW / 10} × ${p.pageH / 10} cm (borderless, no scaling).`,
    '2. Assemble row by row: left to right, top to bottom. Glue each new sheet ON TOP of the',
    `    previous ones — its edges align over the repeated ${p.overlap} mm strip of map.`,
    '3. Page labels sit in the bottom-right overlap corner and get covered as you go.',
  ] : [
    '1. Print every page at 100 % scale ("Actual size" — never "Fit to page").',
    '2. On every sheet cut off the TOP and LEFT white margins, exactly along the printed edge.',
    '3. Assemble row by row: left to right, top to bottom. Glue each new sheet ON TOP of the',
    `    previous ones — its cut edges align over the repeated ${p.overlap} mm strip of map.`,
    '4. Page labels sit in the bottom-right overlap corner and get covered as you go.',
  ];
  for (const line of steps) { pdf.text(line, 15, y); y += 5.5; }

  // layout diagram — each tile is an internal link to its map page
  y += 6;
  pdf.setFontSize(9).setTextColor(120);
  pdf.text(withLinks ? 'Overview — click a tile to jump to its page:'
                     : 'Overview — file names follow the R C grid:', 15, y);
  pdf.setTextColor(0);
  y += 3;
  // the cover itself is A4, regardless of the map-page format
  const coverW = p.landscape ? 297 : 210, coverH = p.landscape ? 210 : 297;
  const boxW = coverW - 30, boxH = coverH - y - 15;
  const k = Math.min(boxW / p.coveredW, boxH / p.coveredH);
  const ox = 15, oy = y;
  pdf.setLineWidth(0.2).setDrawColor(120);
  pdf.setFontSize(Math.min(9, Math.max(5, 60 * k * p.pw / 25)));
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const rx = ox + c * p.sx * k, ry = oy + r * p.sy * k;
      pdf.rect(rx, ry, p.pw * k, p.ph * k);
      pdf.text(`R${r + 1} C${c + 1}`, rx + p.pw * k / 2, ry + p.ph * k / 2, { align: 'center', baseline: 'middle' });
      // link areas must not overlap, so clip each one to the grid step;
      // map pages follow the cover (page 1) in row-major order
      if (withLinks) {
        pdf.link(rx, ry, (c < p.cols - 1 ? p.sx : p.pw) * k, (r < p.rows - 1 ? p.sy : p.ph) * k,
                 { pageNumber: 2 + r * p.cols + c });
      }
    }
  }
  pdf.setDrawColor(0).setLineWidth(0.5);
  pdf.rect(ox, oy, p.coveredW * k, p.coveredH * k);
}

/* --------------------------------------------------------- calibration */

function calibrationPDF() {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297;
  pdf.setLineWidth(0.2);
  pdf.setFont('helvetica', 'normal');

  // Ruler ticks every mm, 0–20 mm from each paper edge. The printer clips
  // whatever falls inside its unprintable margin, so the first visible tick
  // (and number) tells you that edge's margin.
  const tick = (d) => (d % 5 === 0 ? 8 : 4);
  pdf.setFontSize(7);
  for (let d = 0; d <= 20; d++) {
    const L = tick(d);
    pdf.line(W / 2 - L, d, W / 2 + L, d);                 // top
    pdf.line(W / 2 - L, H - d, W / 2 + L, H - d);         // bottom
    pdf.line(d, H / 2 - L, d, H / 2 + L);                 // left
    pdf.line(W - d, H / 2 - L, W - d, H / 2 + L);         // right
    if (d % 5 === 0) {
      pdf.text(String(d), W / 2 + 11, d + 1);
      pdf.text(String(d), W / 2 + 11, H - d + 1);
      pdf.text(String(d), d - 1, H / 2 + 14, { angle: 90 });
      pdf.text(String(d), W - d - 1, H / 2 + 14, { angle: 90 });
    }
  }

  // 100 mm scale bars to verify the print is at 100 % scale
  pdf.setLineWidth(0.4);
  pdf.line(55, 110, 155, 110); pdf.line(55, 107, 55, 113); pdf.line(155, 107, 155, 113);
  pdf.line(40, 90, 40, 190);  pdf.line(37, 90, 43, 90);   pdf.line(37, 190, 43, 190);

  pdf.setFontSize(11);
  pdf.text('Printer calibration', 60, 130);
  pdf.setFontSize(9);
  const txt = [
    '1. Print this page at 100 % scale ("Actual size", no fit-to-page, no borderless mode).',
    '2. Check both bars measure exactly 100 mm with a ruler; otherwise fix the print scaling.',
    '3. On each edge, find the first fully printed ruler tick. Its number (mm) is the',
    '    unprintable margin of that edge — enter the four values in the app.',
    '4. When unsure, round up half a millimetre.',
  ];
  let y = 140;
  for (const line of txt) { pdf.text(line, 60, y); y += 5; }
  pdf.text('bar = 100 mm', 105, 105, { align: 'center' });
  pdf.save('printer-calibration.pdf');
}

/* ----------------------------------------------------------------- init */

function buildCategoryUI() {
  const box = $('cats');
  for (const [key, label] of CATEGORIES) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'cat_' + key;
    cb.checked = true;
    cb.onchange = () => applyVisibility(map);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(' ' + label));
    box.appendChild(lab);
  }
}

function toggleLock() {
  const p = params();
  if (p.error) return;
  if (lockedNW) {
    // keep showing the same area: fit it into the free-floating frame
    const { nw, se } = areaBounds(p);
    const f = frameRect(p);
    lockedNW = lockedSE = null;
    hoverTile = null;
    map.fitBounds([[nw.lng, se.lat], [se.lng, nw.lat]], {
      padding: { top: f.y, bottom: f.y, left: f.x, right: f.x },
      duration: 0,
    });
    $('lockBtn').textContent = '🔒 Lock area & inspect';
  } else {
    const b = areaBounds(p);
    lockedNW = b.nw;
    lockedSE = b.se;
    $('lockBtn').textContent = '🔓 Unlock area';
  }
  refresh();
}

function init() {
  buildCategoryUI();

  map = new maplibregl.Map({
    container: 'map',
    style: STYLES.liberty,
    center: [13.378, 49.747],  // Plzeň
    zoom: 11,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => { buildCategories(); refresh(); });
  map.on('move', () => {
    if (lockedNW) drawOverlay();  // grid is pinned to the map while locked
    updateInfo();
  });

  $('style').onchange = () => {
    map.setStyle(STYLES[$('style').value]);
    map.once('idle', buildCategories);
  };

  for (const id of ['wallW', 'wallH', 'orient', 'mTop', 'mRight', 'mBottom', 'mLeft', 'overlap', 'detail']) {
    $(id).addEventListener('input', refresh);
  }
  window.addEventListener('resize', refresh);

  const wrap = $('mapwrap');
  wrap.addEventListener('mousemove', (e) => {
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    wrap.style.cursor = (dragWall || onWallEdge(mx, my)) ? 'move' : '';
    if (!lockedNW) return;
    const t = tileAt(mx, my);
    if (t?.r !== hoverTile?.r || t?.c !== hoverTile?.c) { hoverTile = t; drawOverlay(); }
  });
  wrap.addEventListener('mouseleave', () => {
    if (hoverTile) { hoverTile = null; drawOverlay(); }
  });

  // drag the wall outline by its edge; capture phase keeps the event from
  // reaching the map, which would pan instead
  wrap.addEventListener('mousedown', (e) => {
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (!onWallEdge(mx, my)) return;
    const p = params();
    const f = viewRect(p);
    dragWall = { mx, my, ox: wallOff.x, oy: wallOff.y, k: f.k };
    e.preventDefault();
    e.stopPropagation();
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!dragWall) return;
    const rect = wrap.getBoundingClientRect();
    wallOff.x = dragWall.ox + (e.clientX - rect.left - dragWall.mx) / dragWall.k;
    wallOff.y = dragWall.oy + (e.clientY - rect.top - dragWall.my) / dragWall.k;
    drawOverlay();   // clamps the offset to the covered area
  });
  window.addEventListener('mouseup', () => { dragWall = null; });

  $('bikePaths').onchange = () => applyBikeLayer(map);
  $('searchBtn').onclick = doSearch;
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('exportBtn').onclick = exportPDF;
  $('calibBtn').onclick = calibrationPDF;
  $('lockBtn').onclick = toggleLock;

  refresh();
}

init();
