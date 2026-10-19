// Human-readable meanings for common group codes (DXF Reference), by context.

const COMMON: Record<number, string> = {
  0: 'Entity type', 1: 'Primary text', 2: 'Name', 3: 'Text / name (additional)', 5: 'Handle', 6: 'Linetype name',
  7: 'Text style name', 8: 'Layer', 39: 'Thickness', 48: 'Linetype scale', 60: 'Visibility (1 = invisible)',
  62: 'Color (ACI; 0 = BYBLOCK, 256 = BYLAYER)', 67: 'Space (1 = paper)', 100: 'Subclass marker',
  102: 'Application group', 330: 'Owner / soft-pointer handle', 340: 'Hard-pointer handle', 350: 'Soft-owner handle',
  360: 'Hard-owner handle', 370: 'Lineweight (1/100 mm; -1 BYLAYER, -2 BYBLOCK, -3 DEFAULT)', 390: 'Plot style handle',
  420: 'True color (0xRRGGBB)', 430: 'Color name', 440: 'Transparency', 410: 'Layout tab name',
  210: 'Extrusion X', 220: 'Extrusion Y', 230: 'Extrusion Z',
  1001: 'XDATA application', 1000: 'XDATA string', 1002: 'XDATA control { }', 1003: 'XDATA layer',
  1005: 'XDATA handle', 1010: 'XDATA point X', 1040: 'XDATA real', 1070: 'XDATA int16', 1071: 'XDATA int32',
  999: 'Comment',
};

const BY_TYPE: Record<string, Record<number, string>> = {
  LINE: { 10: 'Start X', 20: 'Start Y', 30: 'Start Z', 11: 'End X', 21: 'End Y', 31: 'End Z' },
  POINT: { 10: 'Location X', 20: 'Location Y', 30: 'Location Z', 50: 'X-axis angle' },
  CIRCLE: { 10: 'Center X (OCS)', 20: 'Center Y (OCS)', 30: 'Center Z (OCS)', 40: 'Radius' },
  ARC: { 10: 'Center X (OCS)', 20: 'Center Y (OCS)', 30: 'Center Z (OCS)', 40: 'Radius', 50: 'Start angle (deg)', 51: 'End angle (deg)' },
  ELLIPSE: { 10: 'Center X', 20: 'Center Y', 30: 'Center Z', 11: 'Major axis X (rel.)', 21: 'Major axis Y', 31: 'Major axis Z', 40: 'Minor/major ratio', 41: 'Start parameter (rad)', 42: 'End parameter (rad)' },
  LWPOLYLINE: { 90: 'Vertex count', 70: 'Flags (1 closed, 128 plinegen)', 43: 'Constant width', 38: 'Elevation', 10: 'Vertex X', 20: 'Vertex Y', 40: 'Start width', 41: 'End width', 42: 'Bulge (tan(θ/4))', 91: 'Vertex id' },
  POLYLINE: { 66: 'Vertices follow', 10: 'Dummy point (Z = elevation)', 70: 'Flags (1 closed, 8 3D, 16 mesh, 64 polyface)', 40: 'Default start width', 41: 'Default end width', 71: 'Mesh M / polyface vertex count', 72: 'Mesh N / face count', 75: 'Smooth surface type' },
  VERTEX: { 10: 'Location X', 20: 'Location Y', 30: 'Location Z', 40: 'Start width', 41: 'End width', 42: 'Bulge', 70: 'Vertex flags', 71: 'Face vertex 1', 72: 'Face vertex 2', 73: 'Face vertex 3', 74: 'Face vertex 4' },
  TEXT: { 10: 'First alignment point X (OCS)', 20: 'First alignment Y', 30: 'First alignment Z', 11: 'Second alignment X', 21: 'Second alignment Y', 31: 'Second alignment Z', 40: 'Text height', 41: 'Width factor', 50: 'Rotation (deg)', 51: 'Oblique angle', 71: 'Generation flags (2 backward, 4 upside down)', 72: 'Horizontal justification', 73: 'Vertical justification' },
  MTEXT: { 10: 'Insertion X', 20: 'Insertion Y', 30: 'Insertion Z', 40: 'Nominal text height', 41: 'Reference rectangle width', 46: 'Defined height', 71: 'Attachment point (1-9)', 72: 'Drawing direction', 3: 'Text (continued)', 11: 'X-axis direction X', 21: 'X-axis direction Y', 31: 'X-axis direction Z', 42: 'Horizontal width', 43: 'Vertical height', 44: 'Line spacing factor', 50: 'Rotation' },
  INSERT: { 2: 'Block name', 10: 'Insertion X (OCS)', 20: 'Insertion Y', 30: 'Insertion Z', 41: 'X scale', 42: 'Y scale', 43: 'Z scale', 50: 'Rotation (deg)', 66: 'Attributes follow', 70: 'Column count', 71: 'Row count', 44: 'Column spacing', 45: 'Row spacing' },
  ATTRIB: { 1: 'Value', 2: 'Tag', 70: 'Flags (1 invisible, 2 constant)', 40: 'Height', 10: 'Alignment X', 20: 'Alignment Y', 11: 'Second alignment X', 21: 'Second alignment Y', 50: 'Rotation', 72: 'Horizontal justification', 74: 'Vertical justification' },
  ATTDEF: { 1: 'Default value', 2: 'Tag', 3: 'Prompt', 70: 'Flags', 40: 'Height' },
  HATCH: { 2: 'Pattern name', 70: 'Solid fill', 71: 'Associative', 91: 'Boundary path count', 92: 'Path type flags', 93: 'Edge / vertex count', 72: 'Edge type / has bulge', 75: 'Hatch style', 76: 'Pattern type', 52: 'Pattern angle', 41: 'Pattern scale', 78: 'Pattern line count', 53: 'Line angle', 43: 'Line base X', 44: 'Line base Y', 45: 'Line offset X', 46: 'Line offset Y', 79: 'Dash count', 49: 'Dash length', 98: 'Seed point count', 450: 'Gradient flag' },
  DIMENSION: { 2: 'Block name (geometry)', 3: 'Dimension style', 10: 'Definition point X', 11: 'Text midpoint X', 13: 'Definition point 2 X', 14: 'Definition point 3 X', 15: 'Definition point 4 X', 70: 'Dimension type', 42: 'Actual measurement', 1: 'Text override', 50: 'Rotation angle', 53: 'Text rotation' },
  SPLINE: { 70: 'Flags (1 closed, 2 periodic, 4 rational, 8 planar)', 71: 'Degree', 72: 'Knot count', 73: 'Control point count', 74: 'Fit point count', 40: 'Knot value', 41: 'Weight', 10: 'Control point X', 11: 'Fit point X' },
  SOLID: { 10: 'Corner 1 X', 11: 'Corner 2 X', 12: 'Corner 3 X', 13: 'Corner 4 X' },
  '3DFACE': { 10: 'Corner 1 X', 11: 'Corner 2 X', 12: 'Corner 3 X', 13: 'Corner 4 X', 70: 'Invisible edge flags' },
  LAYER: { 2: 'Layer name', 70: 'Flags (1 frozen, 4 locked)', 62: 'Color (negative = off)', 6: 'Linetype', 290: 'Plot flag', 370: 'Lineweight' },
  LTYPE: { 2: 'Linetype name', 3: 'Description', 72: 'Alignment code', 73: 'Element count', 40: 'Total pattern length', 49: 'Dash (+), gap (-), dot (0)', 74: 'Element type flags' },
  STYLE: { 2: 'Style name', 3: 'Primary font file', 4: 'Big font file', 40: 'Fixed height', 41: 'Width factor', 50: 'Oblique angle' },
  BLOCK: { 2: 'Block name', 3: 'Block name', 70: 'Block flags (1 anonymous, 4 xref)', 10: 'Base point X', 1: 'Xref path' },
};

export function groupMeaning(type: string, code: number): string {
  const t = BY_TYPE[type]?.[code];
  if (t) return t;
  if (COMMON[code]) return COMMON[code];
  if (code >= 20 && code <= 29) return `Y of point ${code - 10}`;
  if (code >= 30 && code <= 39) return `Z of point ${code - 20}`;
  return '';
}

export const HANDLE_CODES = (code: number) =>
  code === 5 || code === 105 || (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || code === 480 || code === 481 || code === 1005;
