# Wall Map Tiler

live at: https://michondr.github.io/print-map/

Print any map area as A4 tiles, cut off the white margins, glue to a wall —
edges match perfectly.

Pure static frontend: vanilla HTML/CSS/JS, MapLibre GL + jsPDF from CDN,
no build step, no backend, no API keys.

- **Map data**: OpenStreetMap vector tiles served by [OpenFreeMap](https://openfreemap.org) (free, no key)
- **Search**: OSM Nominatim geocoder
- **Output**: multi-page PDF (cover sheet with assembly instructions + one
  page per tile), or one JPEG/PNG per page for copy-centre large-format
  printing (A4 or 150 × 100 cm poster pages)

## Usage

1. Enter your wall size (cm) and pick A4 portrait/landscape.
2. Print the **calibration sheet**, measure your printer's unprintable
   margins on each edge, and enter them (mm).
3. Search for a place, then pan/zoom the map under the white frame — the
   frame is exactly what ends up on the wall. Orange lines are page cuts,
   shaded strips are the glue overlap.
4. Toggle map content (roads, water, greenery, buildings, labels, …) and style.
5. **Export PDF**, print all pages at 100 % scale.
6. Cut the **top and left** margin off every sheet, assemble left→right,
   top→bottom, gluing each new sheet over the previous ones. The repeated
   overlap strip makes alignment forgiving.

Every page is rendered at a single shared zoom, so lines *and text labels*
continue seamlessly across sheet boundaries. Pages larger than the GPU's
maximum canvas are rendered in several passes and stitched, so even the
150 × 100 cm poster pages come out at 300 dpi in Chromium (~230 dpi in
Firefox, whose canvas limits are lower — the sidebar shows the exact
figure), which is plenty at wall-viewing distance.

## Deploy

Push to `main` on GitHub, then in the repo settings set
**Pages → Source → GitHub Actions**. The included workflow uploads the
static files as-is.

## Local development

Any static file server works, e.g. `python -m http.server` and open
<http://localhost:8000>.
