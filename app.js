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

/* ---------------------------------------------------------------- params */

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

// All lengths in mm unless noted otherwise.
function params() {
  const wallW = num('wallW', 200) * 10;
  const wallH = num('wallH', 150) * 10;
  const landscape = $('orient').value === 'landscape';
  const pageW = landscape ? 297 : 210;
  const pageH = landscape ? 210 : 297;
  const m = { t: num('mTop', 5), r: num('mRight', 5), b: num('mBottom', 5), l: num('mLeft', 5) };
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
  return { wallW, wallH, landscape, pageW, pageH, m, overlap, pw, ph, sx, sy, cols, rows, coveredW, coveredH };
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

// Pages are rendered one at a time, so only a single page has to fit into
// the GPU's maximum canvas size — 300 dpi in practice, whatever the wall size.
function exportDPI(p) {
  const cap = maxRenderPx();
  return Math.min(300, cap / (p.pw / MM_PER_IN), cap / (p.ph / MM_PER_IN));
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
  lines.push(`Pages: ${p.cols} × ${p.rows} = <b>${p.cols * p.rows}</b>`);
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

function refresh() { drawOverlay(); updateInfo(); }

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

    // One hidden map the size of a single page, re-centred for every page,
    // so the render resolution is independent of the wall size. CSS pixel
    // size fixes the physical size of labels/line widths (`ref` dpi
    // reference — 96 css dpi divided down by the detail boost);
    // pixelRatio raises the real resolution up to `dpi`.
    const ref = CSS_DPI * 2 ** boost;
    const cssW = p.coveredW / MM_PER_IN * ref;       // assembled map in css px
    const zoom = Math.log2(cssW / (512 * (se.lng - nw.lng) / 360));
    const pageCssW = p.pw / MM_PER_IN * ref;
    const pageCssH = p.ph / MM_PER_IN * ref;
    const c1 = maplibregl.MercatorCoordinate.fromLngLat(nw);
    const c2 = maplibregl.MercatorCoordinate.fromLngLat(se);
    const pageCenter = (r, c) => new maplibregl.MercatorCoordinate(
      c1.x + (c2.x - c1.x) * (c * p.sx + p.pw / 2) / p.coveredW,
      c1.y + (c2.y - c1.y) * (r * p.sy + p.ph / 2) / p.coveredH, 0).toLngLat();

    status('Rendering map at print resolution — downloading tiles, this can take a minute…');
    holder = document.createElement('div');
    holder.style.cssText = `position:fixed;top:0;left:-${Math.ceil(pageCssW) + 100}px;width:${pageCssW}px;height:${pageCssH}px;`;
    document.body.appendChild(holder);
    em = new maplibregl.Map({
      container: holder,
      style: STYLES[$('style').value],
      center: pageCenter(0, 0), zoom,
      bearing: 0, pitch: 0,
      interactive: false,
      attributionControl: false,
      pixelRatio: dpi / ref,
      preserveDrawingBuffer: true,
      fadeDuration: 0,
      maxZoom: 24,
    });
    await once(em, 'load');
    applyVisibility(em);
    await once(em, 'idle');

    const { jsPDF } = window.jspdf;
    const orientation = p.landscape ? 'landscape' : 'portrait';
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation, compress: true });
    coverPage(pdf, p, { nw, se, dpi, zoom });

    const total = p.cols * p.rows;
    const pageCv = document.createElement('canvas');
    const ctx = pageCv.getContext('2d');
    let n = 0;
    for (let r = 0; r < p.rows; r++) {
      for (let c = 0; c < p.cols; c++) {
        status(`Rendering page ${++n} / ${total}…`);
        em.jumpTo({ center: pageCenter(r, c) });
        await once(em, 'idle');
        await raf();
        const src = em.getCanvas();
        const ppm = src.width / p.pw;  // rendered pixels per mm
        pageCv.width = src.width;
        pageCv.height = src.height;
        ctx.drawImage(src, 0, 0);
        if ($('pageLabels').checked) drawPageLabel(ctx, pageCv, `R${r + 1} C${c + 1}`, ppm);
        pdf.addPage('a4', orientation);
        pdf.addImage(pageCv.toDataURL('image/jpeg', 0.92), 'JPEG', p.m.l, p.m.t, p.pw, p.ph);
      }
    }
    pdf.save('wall-map.pdf');
    status(`Done — ${total} map pages + cover sheet.`);
  } catch (e) {
    status('Export failed: ' + e.message);
    console.error(e);
  } finally {
    if (em) em.remove();
    if (holder) holder.remove();
    btn.disabled = false;
  }
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

function coverPage(pdf, p, x) {
  const midLat = (x.nw.lat + x.se.lat) / 2;
  const metres = (x.se.lng - x.nw.lng) / 360 * EARTH_CIRC * Math.cos(midLat * Math.PI / 180);
  const scale = Math.round(metres / (p.coveredW / 1000));

  pdf.setFont('helvetica', 'bold').setFontSize(20);
  pdf.text('Wall map', 15, 20);
  pdf.setFont('helvetica', 'normal').setFontSize(10);
  const meta = [
    `Pages: ${p.cols} × ${p.rows} = ${p.cols * p.rows} (A4 ${p.landscape ? 'landscape' : 'portrait'})`,
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
  const steps = [
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
  pdf.text('Overview — click a tile to jump to its page:', 15, y);
  pdf.setTextColor(0);
  y += 3;
  const boxW = p.pageW - 30, boxH = p.pageH - y - 15;
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
      pdf.link(rx, ry, (c < p.cols - 1 ? p.sx : p.pw) * k, (r < p.rows - 1 ? p.sy : p.ph) * k,
               { pageNumber: 2 + r * p.cols + c });
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
    center: [14.42, 50.088],   // Prague
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
    if (!lockedNW) return;
    const rect = wrap.getBoundingClientRect();
    const t = tileAt(e.clientX - rect.left, e.clientY - rect.top);
    if (t?.r !== hoverTile?.r || t?.c !== hoverTile?.c) { hoverTile = t; drawOverlay(); }
  });
  wrap.addEventListener('mouseleave', () => {
    if (hoverTile) { hoverTile = null; drawOverlay(); }
  });

  $('searchBtn').onclick = doSearch;
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('exportBtn').onclick = exportPDF;
  $('calibBtn').onclick = calibrationPDF;
  $('lockBtn').onclick = toggleLock;

  refresh();
}

init();
