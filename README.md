# Vectra CAD — a clean-room DXF viewer & editor

A browser app that opens AutoCAD drawings (DXF), shows them in full detail and lets you
edit and save them. It was built **clean-room from the public file specifications**
(Autodesk *DXF Reference*). No AutoCAD binaries were inspected or decompiled.

```bash
npm install
npm run dev          # http://localhost:5173 — open a .dxf (Open / drag & drop / Samples)
npm test             # 94 unit tests: lossless round-trip, renderer/transform agreement, editing
```

Optional Python tooling (an independent DXF implementation, used for samples and validation):

```bash
python -m venv .venv && .venv/Scripts/pip install ezdxf matplotlib
npm run samples                      # regenerate public/samples/*.dxf
npm run validate -- some.dxf         # ezdxf load + audit of any file (e.g. one saved by the app)
npm run check:browser                # drives the running dev server (port 5199) in headless Edge
```

---

## Desktop app (Windows, works offline)

**Install:** run `release\Vectra-CAD-Setup-0.1.0.exe`. It installs per-user (no admin needed), adds Start-menu and
desktop shortcuts, and registers **.dxf** and **.dwg**, so double-clicking a drawing opens it in Vectra CAD.
The installer is unsigned, so Windows SmartScreen may ask you to confirm ("More info → Run anyway").

**Behaviour:**
- **Offline:** no internet is used or allowed. The app is served from a private `app://` scheme, and every network
  request is blocked.
- **Files:** native Open / Save / Save As dialogs, plus the File, Edit, View and Help menus.
  - Ctrl+S writes back to the opened `.dxf`.
  - For a DWG, Save proposes a `.dxf` next to it.
- **Windows:** a drawing double-clicked while the app is running opens in the existing window.
- **Unsaved changes:** closing with unsaved changes asks Save / Don't Save / Cancel. Just opening a file doesn't count as a change.
- **Security:** the page runs sandboxed under a strict content security policy. Only the DWG-reader worker may
  evaluate code, which LibreDWG's WebAssembly bindings need.

**Build it yourself:**

```bash
npm run app            # build and run the desktop app from source
npm run dist:win       # build the installer -> release/Vectra-CAD-Setup-<version>.exe
npm run check:electron # end-to-end test of the desktop app (open, save in place, DWG, offline)
```

The desktop shell is in `electron/`: `main.mjs` (window, `app://` server, dialogs, menus) and `preload.cjs`
(the only bridge the page can use). The page uses it through `src/desktop.ts`, and runs unchanged in a browser.

## Opening DWG files

DWG (AutoCAD's binary format) opens like DXF: use **Open**, drag & drop, or **Samples → DWG: …**.
R13/R14 and AutoCAD 2000–2018 files work.

- **How:** [LibreDWG](https://www.gnu.org/software/libredwg/) is compiled to WebAssembly
  (`@mlightcad/libredwg-web`) and converts the DWG to a DXF of the same version. Our lossless DXF pipeline then
  reads it, so viewing, inspecting and editing all work as usual (`src/dwg/`).
- **Performance:** the converter runs in a Web Worker, a fresh one per file, so a large file doesn't freeze the page
  and a crash can't affect the next file. The 10.8 MB `.wasm` (2.5 MB gzipped) is fetched only the first time a DWG is opened.
- **Saving** writes DXF (`name.dxf`, same AutoCAD version). DWG can't be written back.
- **Known LibreDWG gaps:**
  - In AutoCAD 2010+ files, tables come out empty. They're left out, with a warning.
  - Pre-R13 DWG isn't supported.
  - ACIS solids are kept but not drawn, as with DXF.
- **Licence:** LibreDWG is GPL-3.0, so this project is GPL-3.0 (`LICENSE`, `THIRD_PARTY_NOTICES.md`).

## How AutoCAD represents a drawing (what we reproduced)

| Concept | How it works | Where |
|---|---|---|
| **Group codes** | A DXF file is a flat stream of `(code, value)` pairs. The code fixes the type: 0 = record type, 5 = handle, 8 = layer, 10/20/30 = a point's X/Y/Z, 62 = colour, 100 = subclass marker, 1001+ = XDATA. | `src/dxf/groups.ts`, `tokenizer.ts` |
| **Drawing database** | Sections HEADER (system variables such as `$ACADVER`, `$LTSCALE`, `$HANDSEED`), CLASSES, TABLES (LAYER, LTYPE, STYLE, DIMSTYLE, BLOCK_RECORD…), BLOCKS, ENTITIES and OBJECTS (dictionaries, layouts…). Every object has a hex **handle** and an **owner** handle (330). | `src/model/database.ts` |
| **Lossless records** | Each object keeps its exact group list. Typed meaning is decoded on demand, and edits rewrite only individual groups, so unknown objects, XDATA, reactors and proxies survive load → edit → save. | `src/dxf/record.ts`, `writer.ts` |
| **Version differences** | R12 (AC1009) has no subclass markers and often no handles. R13+ adds `100` markers and owners. R2007+ files are UTF-8, while older files use an ANSI code page, so non-ASCII text is written as `\U+XXXX`. | `tokenizer.ts`, `writer.ts`, `edit/create.ts` |
| **OCS / extrusion** | 2D entities (CIRCLE, ARC, LWPOLYLINE, TEXT, INSERT, HATCH…) store coordinates in an *Object Coordinate System* derived from the extrusion vector (210) by the **Arbitrary Axis Algorithm**. LINE, ELLIPSE, SPLINE and MTEXT are in WCS. | `src/geom/ocs.ts` |
| **Property resolution** | Colour, linetype and lineweight can be explicit, **BYLAYER** or **BYBLOCK**. Inside a block, entities on layer **0** take the INSERT's layer, and BYBLOCK takes the INSERT's resolved value. Layer *off* = negative colour; *frozen* = flag bit 1. | `src/render/style.ts` |
| **Blocks** | INSERT = base point, OCS, insertion point, rotation, X/Y/Z scale, plus MINSERT rows/columns. Nesting is recursive. Dimensions and tables are references to anonymous `*D` / `*T` blocks holding their pre-computed graphics. | `src/render/geometry.ts` |
| **Curves** | Bulge = tan(θ/4) per polyline vertex; ellipses use parametric angles; SPLINEs are (rational) NURBS evaluated with de Boor's algorithm. | `src/geom/tessellate.ts` |
| **Linetypes** | LTYPE elements: dash (+), gap (−), dot (0), scaled by `$LTSCALE` × entity scale (48) × block scale. | `render/style.ts`, `canvas.ts` |
| **Hatches** | Boundary loops: polyline (with bulges) or edge lists (line, arc, ellipse, spline). Pattern lines (angle, base, offset, dashes) are already scaled and rotated in the file, and there are gradient fills. Islands use even-odd parity. | `src/render/hatch.ts` |
| **Text** | TEXT has 72/73 justification and second alignment points (aligned/fit), plus `%%c %%d %%p` codes. MTEXT has inline formatting codes (`\P \H \C \f \L \S` …), word wrap to the reference width, and a 1–9 attachment point. Text height is *cap* height. | `src/render/text.ts` |

## 3D viewing

A parallel (orthographic) view is an affine map, so geometry is built once in 3D world coordinates
(`Prim3`) and projected per view into 2D camera space (`projectPrim`). The existing 2D renderer, picking,
snapping, grips and editing all run on the projected geometry, so they work in every view. The top view is
the identity rotation, which gives exactly the same output as before (`src/geom/view.ts`, `src/render/prims.ts`, `src/render/scene.ts`).

- **Views:** Top, Bottom, Front, Back, Left, Right, and the four isometrics (toolbar or `VIEW`). Return to the top view with `PLAN`.
  Orbit with **Shift + middle-drag** or the Orbit toggle (`3DORBIT`). Drawings open in their saved
  `*Active` VPORT view direction.
- **Visual styles** (`VSCURRENT`): 2D Wireframe, Hidden, Shaded, Shaded + edges. Faces are lit with a two-sided headlight.
  Non-wireframe styles draw back to front using the painter's algorithm.
- **3D entities:**
  - 3DFACE with invisible edges.
  - Polygon and polyface meshes (hidden edges via negative indices).
  - **MESH** (AutoCAD 2010+ subdivision mesh, control cage).
  - **Thickness** (group 39) on LINE, CIRCLE, ARC, polylines and POINT.
  - Text and other entities on any plane.
- **Editing in 3D views:** clicks land on the Z = 0 working plane, or on the snapped object's real 3D point.
  Grips move within their own Z plane. Front and side views are edge-on to the XY plane, so use snaps or typed coordinates there.
  A triad in the lower-left corner shows the orientation. The status bar shows X, Y, Z.

## UCS (user coordinate system)

AutoCAD's UCS is a movable frame (origin plus X/Y axes). Typed and picked coordinates, the coordinate readout,
ortho, the drawing plane and dimension directions all use it. Geometry is still stored in WCS/OCS. Here the frame is
`src/model/ucs.ts`.

- **`UCS`**: pick a new origin (Enter to accept), or also pick a point on the new X axis and one in the new XY plane
  (3-point). Other options: World, Previous, View (XY parallel to the screen), X/Y/Z (rotate about an axis), and
  NAmed (Save / Restore / Delete / ? on the UCS table). The toolbar UCS menu offers the same choices.
- The current UCS is saved in the drawing (`$UCSORG/$UCSXDIR/$UCSYDIR/$UCSNAME` and the `*Active` viewport). UCS changes can be undone.
- The **UCS icon** sits at the origin. `UCSICON` takes ON, OFF, ORigin or Noorigin.
- In a tilted UCS, entities drawn there get the UCS Z axis as their extrusion and OCS coordinates. MOVE, ROTATE and SCALE use UCS directions.

## Dimensions

Dimensions are real `DIMENSION` entities, like AutoCAD's. Each has definition points plus an anonymous `*D` block holding
the drawn graphics: extension lines, closed-filled arrows, and the **label in the drawing** (MTEXT, or TEXT in R12).
They use the current dimension style (`DIMSTYLE`): text height, arrow size, offsets, decimals, zero suppression, DIMLFAC,
DIMPOST, and whether text sits above the line or centred in it (`src/dims/`).

| Command | What it does |
|---|---|
| `DIMLINEAR` (DLI) | Horizontal or vertical, chosen by cursor position against the UCS axes, or Rotated. Enter selects a LINE. |
| `DIMALIGNED` (DAL) | Parallel to the two points. |
| `DIMRADIUS` (DRA), `DIMDIAMETER` (DDI) | Select an arc or circle, then place the label (`R…`, `⌀…`). |
| `DIMANGULAR` (DAN) | Select an arc, a circle (plus a second point), two lines, or Enter for vertex plus two points. |
| `DIMORDINATE` (DOR) | X or Y distance from the **UCS origin**; the datum follows the leader direction or Xdatum/Ydatum. |
| `DIMEDIT` (DED) | Change the label text of selected (or picked) dimensions; `<>` = measured value. |
| `DIMDYN` | Dynamic label height: labels follow the measured value (ratio, limits, rounding). |
| `DIMSTYLE` (D, DDIM) | The **Dimension Style Manager** (see below). `-DIMSTYLE` lists styles and sets the current one at the command line. |

All of these, plus `DIST` and `ID`, are in the toolbar's **Measure / Dimension** dropdown. Its groups are Measure, Create dimension, Edit, and Size & style.

**Label size.** New dimensions are sized automatically. The label is at least 1/70 of the drawing's extent (other
dimensions excluded), rounded up to a standard height (… 2.5, 3.5, 5, 7 …). It is never smaller than the style's own.
The size is stored the AutoCAD way, as a per-dimension `DIMSCALE` override in `ACAD`/`DSTYLE` XDATA, so text, arrows and
gaps scale together and AutoCAD shows the same size. `DIMSCALE` sets a fixed factor, or `Auto`, for new dimensions and for
selected ones. The Properties panel shows each dimension's text height and lets you edit its scale.

**Resizing labels.**
- **One dimension:** select it and type a height in Properties → **Text height**. Leave it empty to go back to the style's height.
- **Several dimensions:** select them all; Properties then shows one shared **Text height** field.
- **New dimensions:** `DIMTXT` (Dimension menu → Label height…) sets the height used from then on, and also applies it to
  any selected dimensions. `DIMTXT Auto` returns to automatic sizing.

Text height only resizes the label: it is stored as a DIMTXT override, divided by DIMSCALE so the height is exact.
To resize the label *and* the arrows/gaps together, use `DIMSCALE` or the **Dim scale** field instead.

**Dynamic label height** (`DIMDYN`, or `DIMTXT` → Dynamic, or Measure / Dimension → Dynamic label height…).
Each label's height follows what its dimension measures:
- **What counts as the measured size:** the length, the radius or diameter, the arc length for angles, or the leader length for ordinates.
- **Formula:** height = size × ratio (default 8 %), kept between a minimum and maximum (defaults: drawing extent / 250 and / 25), then rounded to the nearest standard height (… 2.5, 3.5, 5, 7, 10 …). Rounding can be turned off.
- **Stays live:** the settings are stored on each dimension (`CADWEB`/`DYNTXT` XDATA), so the label resizes again after grip edits and SCALE.
- **Compatibility:** the current height is also saved as a normal DIMTXT override, so AutoCAD and ezdxf show the same size.
- **Properties:** toggle **Dynamic height** and edit **Height ratio %**. Turning it off keeps the current height as a fixed one.

Every command previews live while you place it. `[Text]` sets an override, where `<>` stands for the measured value.
Selecting a dimension shows grips on its definition points and text. Dragging one **re-measures and regenerates** the
dimension, as AutoCAD does. The text override can also be edited in Properties.

## Dimension Style Manager

`DIMSTYLE` (`D`), Measure / Dimension → **Style…**, or **Edit style…** next to a selected dimension's style in Properties
opens AutoCAD's Dimension Style Manager (`src/ui/dimstyle-dialog.ts`). It works on the drawing's real DIMSTYLE table,
so styles round-trip to AutoCAD.

**Manager.**
- The style list (All styles / Styles in use) and a live preview and description of the selected style.
- **Set Current** writes `$DIMSTYLE`.
- **New…** starts from a chosen style.
- **Modify…** edits a style. On OK every dimension that uses it is **regenerated**.
- **Override…** sets `<style overrides>`, which apply to new dimensions only (as `DSTYLE` XDATA, as AutoCAD does). They can be saved to the style or cleared.
- **Compare…** lists every differing variable, or all properties of one style.
- **Rename** also updates the dimensions that use the style.
- **Delete** is refused for Standard and for styles that are current or in use.
- Everything is undoable.

**New / Modify / Override dialog.** It has seven tabs with a preview that redraws on every change:
| Tab | Settings (system variable) |
|---|---|
| Lines | Dimension line colour, linetype, lineweight, extension beyond ticks, baseline spacing, suppress 1/2 (DIMCLRD, DIMLTYPE, DIMLWD, DIMDLE, DIMDLI, DIMSD1/2). Extension line colour, linetypes 1/2, lineweight, suppress 1/2, extension, offset, fixed length (DIMCLRE, DIMLTEX1/2, DIMLWE, DIMSE1/2, DIMEXE, DIMEXO, DIMFXLON, DIMFXL). |
| Symbols and Arrows | First / second / leader arrowheads, all 20 AutoCAD types (DIMBLK, DIMBLK1/2, DIMSAH, DIMLDRBLK); arrow and tick size (DIMASZ, DIMTSZ); centre marks None / Mark / Line (DIMCEN); arc length symbol (DIMARCSYM); jog angle (DIMJOGANG). |
| Text | Text style, colour, fill none / background / colour, height, fraction height scale (DIMTXSTY, DIMCLRT, DIMTFILL, DIMTFILLCLR, DIMTXT, DIMTFAC); vertical Centered / Above / Outside / JIS / Below, horizontal position, offset and frame (DIMTAD, DIMJUST, DIMGAP); alignment Horizontal / Aligned / ISO (DIMTIH, DIMTOH). |
| Fit | What moves out when there's no room, keep text inside, suppress arrows (DIMATFIT, DIMTIX, DIMSOXD); text placement beside / over with leader / over without (DIMTMOVE); overall scale (DIMSCALE); manual text, line between extension lines (DIMUPT, DIMTOFL). |
| Primary Units | Scientific, Decimal, Engineering, Architectural (`1'-6 1/2"`), Fractional (stacked), Windows; precision, fraction format, decimal separator, round-off, prefix/suffix, scale factor, zero suppression (DIMLUNIT, DIMDEC, DIMFRAC, DIMDSEP, DIMRND, DIMPOST, DIMLFAC, DIMZIN). Angular: decimal degrees, DMS, grads, radians, precision, zeros (DIMAUNIT, DIMADEC, DIMAZIN). |
| Alternate Units | On/off, format, precision, multiplier, round-off, prefix/suffix, after or below the primary value, zeros (DIMALT, DIMALTU, DIMALTD, DIMALTF, DIMALTRND, DIMAPOST, DIMALTZ). |
| Tolerances | None / Symmetrical / Deviation / Limits / Basic, precision, upper/lower, height scale, vertical position, zeros, alternate-unit tolerance (DIMTOL, DIMLIM, DIMTDEC, DIMTP, DIMTM, DIMTOLJ, DIMTZIN, DIMALTTD, DIMALTTZ). |

**How it maps to the file:**
- Each variable is one entry in `src/dims/vars.ts`, with its group code, defaults (imperial / metric) and the first DXF version that stores it. Reading, writing, overrides, the dialog and Compare all use that table.
- Fields the file's version can't store are greyed out, for example fixed-length extension lines in a 2000 file. Writing skips those codes.
- Text style, linetypes and arrows are stored as handles from R2000. R12 stores arrows by name.
- Arrow blocks such as `_ArchTick` are created in BLOCKS / BLOCK_RECORD the first time a style uses them.
- The builder (`src/dims/build.ts`) honours every setting when it regenerates a dimension's `*D` block:
  - per-part colours, linetypes and lineweights;
  - suppression;
  - all arrow shapes (`src/dims/arrows.ts`);
  - text placement, frame and background mask;
  - the Fit rules;
  - centre marks;
  - unit, alternate-unit and tolerance formatting (`src/dims/format.ts`), including MTEXT stacked fractions and tolerances (`\S…;`), which the renderer draws stacked.
- One gap: the text fill (DIMTFILL / DIMTFILLCLR) has no DIMSTYLE group code of its own, so the style stores it in `CADWEB` XDATA. Dimensions get it as a normal MTEXT background mask, which AutoCAD shows.

## Fonts: Roman S everywhere

All text draws in **Roman Simplex**, the single-stroke design of AutoCAD's `romans.shx`, as vector strokes. This covers TEXT,
MTEXT, attributes, dimension labels and table text (`src/render/romans.ts`). `%%d`, `%%p` and `%%c` give the matching
°, ± and ⌀. Characters the font doesn't have (accented letters, CJK) fall back to a system font.

When a drawing opens, every text style is pointed at `romans.shx`. TrueType family XDATA and MTEXT `` font switches are
removed, so saved files open in AutoCAD with the same font. This is one undoable step ("Roman S fonts").
`ROMANS OFF` shows each style's own font again and is remembered in the browser; `ROMANS ON` switches back.

Glyph data: the Hershey Roman Simplex font (`rowmans.jhf`), converted by `scripts/jhf_to_ts.py`.
*The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards.
The format of the Font data in this distribution was originally created by James Hurt, Cognition, Inc., 900 Technology
Park Drive, Billerica, MA 01821.*

## Features

**Viewing.** Supported entity types:

- LINE, CIRCLE, ARC, ELLIPSE, LWPOLYLINE (bulges, constant and varying widths)
- POLYLINE: 2D, 3D, polygon mesh, polyface
- SPLINE: control points or fit points
- POINT, SOLID, TRACE, 3DFACE
- TEXT, ATTRIB, ATTDEF, MTEXT
- INSERT: nested, mirrored, arrays, attributes
- HATCH: solid, pattern, gradient
- DIMENSION and ARC_DIMENSION, LEADER, MULTILEADER, ACAD_TABLE
- XLINE, RAY, WIPEOUT, IMAGE frame, MLINE (centre line), TOLERANCE

The viewer also handles layers (on/off, freeze, colour), ACI and true colour, linetypes and lineweights. You can pan, zoom at the cursor and zoom to extents, use dark and light backgrounds, and work with 20k-entity drawings interactively.

**Inspecting.**

- Properties panel with computed geometry (length, area, radius…).
- Every DXF group shown with its meaning, and **editable in place**.
- Handle links let you follow owners and references (block records, dictionaries…).
- Explorer for header variables, tables, blocks, objects, and entity counts by type.

**Editing** (all undoable, and saved back to the file's own DXF version):

- AutoCAD-style command line: `LINE PLINE RECTANG CIRCLE ARC TEXT MOVE COPY ROTATE SCALE ERASE UNDO REDO ZOOM DIST ID LIST LAYER REGEN HELP`.
- Coordinate input: `x,y`, `@dx,dy`, `@d<angle`, or direct distance entry.
- Object snaps: end, mid, center, quadrant, intersection, insertion, node.
- ORTHO (F8), OSNAP (F3).
- Window and crossing selection; grips (stretch vertices, move, resize).
- Property changes: layer, colour, linetype, lineweight, linetype scale.
- Copies get fresh handles. Copied dimensions get their own anonymous block.

## Verification

- `test/roundtrip.test.ts`: parse → write reproduces the group stream exactly for R12, R14, R2000 and R2018 files, including real AutoCAD output (LibreDWG test data).
- `test/ucs.test.ts` and `test/dims.test.ts`:
  - UCS round trips, persistence (also read by ezdxf), and drawing/MOVE/ROTATE in moved, rotated and vertical UCSs.
  - Every dimension type: measurement, label, render, undo, and grip regeneration.
  - Ordinate dimensions measured from a moved or rotated UCS origin.
  - Measurements also match ezdxf's independent `get_measurement()`.
- `test/view.test.ts`: view math and preset orientations, ray/plane round trips, MESH and polyface faces, thickness,
  text on vertical planes, picking and window selection in isometric views, and MESH transforms.
- `test/dimstyle.test.ts`:
  - every unit, angle, alternate-unit and tolerance format;
  - the builder honouring each setting;
  - create / rename / delete-in-use / compare;
  - version-filtered writing (R12 / 2000 / 2018);
  - regenerating after modify;
  - exact undo.
  ezdxf reads every written style value back.
- `test/edit.test.ts`: for every entity in every sample, transforming the *data* matches transforming the *rendered geometry*, and undo restores the file byte-for-byte.
- All edited outputs pass `ezdxf.audit()` with 0 errors.
- The browser scripts run the real UI (selection, grips, commands, raw edits, save). Screenshots were compared against ezdxf's own renderer (`scripts/ref_render.py`).

## Known limitations

- **DWG** can be read (via LibreDWG) but not written; see "Opening DWG files".
- **Binary DXF** is not read.
- **Paper space** layouts and viewports are not shown.
- **3D views** are parallel projections only (no perspective).
  - Hidden and shaded styles use the painter's algorithm (sorted by face centroid), so faces that intersect or interlock can draw in the wrong order.
  - MESH draws its control cage, without subdivision smoothing.
  - New geometry is drawn in the WCS XY plane (no UCS).
  - Rotation is about the Z axis only.
- **ACIS solids** (REGION, 3DSOLID, BODY, SURFACE) and proxy entities are kept and saved, but not drawn.
- **SHX fonts** are approximated with system fonts. Complex linetypes (embedded text and shapes) draw only their dashes.
- **Dimensions** from other programs are moved, rotated and scaled with their block. They are regenerated only when their style is modified in the Dimension Style Manager, or when they are grip-edited.
- **Commands not implemented:** OFFSET, TRIM, EXTEND, FILLET, HATCH creation and block editing.
- **Dimensions:**
  - No baseline/continue, jogged or arc-length dimensions (their style settings are stored but unused).
  - No "Use for" child styles (e.g. `Standard$2` for radius only), sub-units, or "Scale dimensions to layout".
  - User-defined arrow blocks are kept and listed, but drawn as closed filled.
- **Tilted UCS:** a few angle-only fields (POINT and MTEXT rotation, dimension text angle) assume rotation about WCS Z.
