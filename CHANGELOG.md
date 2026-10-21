# Changelog

Each version is a GitHub release with the Windows installer attached
(https://github.com/JaySPX05/vectra-cad/releases). New features go into a new version:
see "Releasing" in the README.

## 0.2.0 — more drawing space

- **Properties pops up only when something is selected.** It floats over the right edge of the drawing, so selecting
  an object no longer resizes the view. `×` closes it until the next selection; Esc clears the selection and closes it.
- **Ctrl+1**, the toolbar **Properties** toggle or `PROPERTIES` (`PR`) keep Properties open (drawing information when
  nothing is selected).
- **The Layers / Drawing database column can be hidden**: the toolbar **Layers** toggle, the `«` button in its title,
  or **Ctrl+2**. The choice is remembered; `LAYER` (`LA`) shows it again.
- Both are also in the desktop app's **View** menu.

## 0.1.0 — first release

**Viewing**
- Opens DXF files from AutoCAD R12 to 2018+, losslessly: everything the app doesn't edit is saved back unchanged.
- Opens DWG files (2000–2018+) through LibreDWG. Saving writes DXF.
- Draws lines, arcs, polylines, splines, hatches, text and MTEXT, blocks, dimensions, leaders, 3D faces and meshes.
- Parallel 3D views (top, front, isometric and orbit), with wireframe, hidden and shaded styles.
- Uses the Roman Simplex (romans.shx) stroke font for all text.

**Editing**
- Draw, move, copy, rotate, scale and erase; grip editing; undo/redo; raw group-code editing.
- UCS: set the origin, rotate the axes, and use named UCSs.

**Dimensions**
- Linear, aligned, radius, diameter, angular and ordinate dimensions, with labels drawn in the drawing.
- Label height can be automatic, fixed (`DIMTXT`), or dynamic, following the measured value (`DIMDYN`).
- Dimension Style Manager: set current, new, modify, override, compare, rename and delete styles. The edit dialog has all seven AutoCAD tabs (lines, arrows, text, fit, primary units, alternate units, tolerances) and a live preview.

**Desktop app**
- A Windows installer (`Vectra-CAD-Setup-0.1.0.exe`) that installs for your user account only, with no admin rights needed.
- Works fully offline.
- Registers .dxf and .dwg files, so double-clicking a drawing opens it in Vectra CAD.
