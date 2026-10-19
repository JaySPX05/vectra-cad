# Third-party notices

Vectra CAD is distributed under the GNU General Public License v3.0 (see `LICENSE`), because it
includes the GPL-3.0 components below.

## LibreDWG (via @mlightcad/libredwg-web)
- Reads DWG files: compiled to WebAssembly and loaded only when a DWG is opened (`src/dwg/`).
- LibreDWG — Copyright (C) Free Software Foundation, Inc. — GPL-3.0-or-later — https://www.gnu.org/software/libredwg/
- @mlightcad/libredwg-web — MLight Lee — GPL-3.0 — https://github.com/mlightcad/libredwg-web
- Source: the WebAssembly build is produced from the libredwg-web repository above.

## Hershey fonts (Roman Simplex stroke font, `src/render/romans-glyphs.ts`)
- The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the
  U. S. National Bureau of Standards.
- The format of the Font data in this distribution was originally created by
  James Hurt, Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821.
- Data taken from https://github.com/kamalmostafa/hershey-fonts (`rowmans.jhf`).

## Sample DWG/DXF drawings in `public/samples/public/`
- `example_*.dwg` / `example_*.dxf` come from the LibreDWG test suite (GPL-3.0).
