/**
 * Every dimension-style variable the Dimension Style Manager edits, with its DXF group code
 * (DIMSTYLE table entry / DSTYLE override XDATA), value kind, AutoCAD defaults (imperial and
 * metric ISO-25), the first DXF version that stores it, and where it appears in the dialog.
 * Codes and versions follow the DXF reference (cross-checked with ezdxf).
 */
export type VarKind =
  | 'real' // a number
  | 'dist' // a number in drawing units (scaled by DIMSCALE when used)
  | 'int'
  | 'bool' // 0/1
  | 'enum' // int with named options
  | 'color' // ACI 0 = ByBlock, 256 = ByLayer
  | 'lweight' // 1/100 mm, -1 ByLayer, -2 ByBlock, -3 Default
  | 'string'
  | 'style' // STYLE name (handle 340 in R2000+)
  | 'ltype' // LTYPE name (handle in R2007+); '' = ByBlock
  | 'arrow'; // arrow block name ('' = closed filled); handle in R2000+, string in R12

export type Tab = 'Lines' | 'Symbols and Arrows' | 'Text' | 'Fit' | 'Primary Units' | 'Alternate Units' | 'Tolerances';

export interface DimVar {
  name: string;
  code: number;
  kind: VarKind;
  imp: number | string; // imperial default
  met: number | string; // metric default
  /** First $ACADVER that stores it (AC1009 = R12, AC1015 = 2000, AC1021 = 2007). */
  since: 'AC1009' | 'AC1015' | 'AC1021';
  tab: Tab;
  group: string;
  label: string;
  options?: [number, string][];
  /** R12 string code for arrow names (5/6/7). */
  r12code?: number;
}

export const DIM_VARS: DimVar[] = [
  // ---- Lines ------------------------------------------------------------------------------
  { name: 'DIMCLRD', code: 176, kind: 'color', imp: 0, met: 0, since: 'AC1009', tab: 'Lines', group: 'Dimension lines', label: 'Color' },
  { name: 'DIMLTYPE', code: 345, kind: 'ltype', imp: '', met: '', since: 'AC1021', tab: 'Lines', group: 'Dimension lines', label: 'Linetype' },
  { name: 'DIMLWD', code: 371, kind: 'lweight', imp: -2, met: -2, since: 'AC1015', tab: 'Lines', group: 'Dimension lines', label: 'Lineweight' },
  { name: 'DIMDLE', code: 46, kind: 'dist', imp: 0, met: 0, since: 'AC1009', tab: 'Lines', group: 'Dimension lines', label: 'Extend beyond ticks' },
  { name: 'DIMDLI', code: 43, kind: 'dist', imp: 0.38, met: 3.75, since: 'AC1009', tab: 'Lines', group: 'Dimension lines', label: 'Baseline spacing' },
  { name: 'DIMSD1', code: 281, kind: 'bool', imp: 0, met: 0, since: 'AC1015', tab: 'Lines', group: 'Dimension lines', label: 'Suppress dim line 1' },
  { name: 'DIMSD2', code: 282, kind: 'bool', imp: 0, met: 0, since: 'AC1015', tab: 'Lines', group: 'Dimension lines', label: 'Suppress dim line 2' },
  { name: 'DIMCLRE', code: 177, kind: 'color', imp: 0, met: 0, since: 'AC1009', tab: 'Lines', group: 'Extension lines', label: 'Color' },
  { name: 'DIMLTEX1', code: 346, kind: 'ltype', imp: '', met: '', since: 'AC1021', tab: 'Lines', group: 'Extension lines', label: 'Linetype ext line 1' },
  { name: 'DIMLTEX2', code: 347, kind: 'ltype', imp: '', met: '', since: 'AC1021', tab: 'Lines', group: 'Extension lines', label: 'Linetype ext line 2' },
  { name: 'DIMLWE', code: 372, kind: 'lweight', imp: -2, met: -2, since: 'AC1015', tab: 'Lines', group: 'Extension lines', label: 'Lineweight' },
  { name: 'DIMSE1', code: 75, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Lines', group: 'Extension lines', label: 'Suppress ext line 1' },
  { name: 'DIMSE2', code: 76, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Lines', group: 'Extension lines', label: 'Suppress ext line 2' },
  { name: 'DIMEXE', code: 44, kind: 'dist', imp: 0.18, met: 1.25, since: 'AC1009', tab: 'Lines', group: 'Extension lines', label: 'Extend beyond dim lines' },
  { name: 'DIMEXO', code: 42, kind: 'dist', imp: 0.0625, met: 0.625, since: 'AC1009', tab: 'Lines', group: 'Extension lines', label: 'Offset from origin' },
  { name: 'DIMFXLON', code: 290, kind: 'bool', imp: 0, met: 0, since: 'AC1021', tab: 'Lines', group: 'Extension lines', label: 'Fixed length extension lines' },
  { name: 'DIMFXL', code: 49, kind: 'dist', imp: 1, met: 1, since: 'AC1021', tab: 'Lines', group: 'Extension lines', label: 'Length' },

  // ---- Symbols and Arrows ---------------------------------------------------------------------
  { name: 'DIMBLK1', code: 343, kind: 'arrow', imp: '', met: '', since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'First', r12code: 6 },
  { name: 'DIMBLK2', code: 344, kind: 'arrow', imp: '', met: '', since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Second', r12code: 7 },
  { name: 'DIMLDRBLK', code: 341, kind: 'arrow', imp: '', met: '', since: 'AC1015', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Leader' },
  { name: 'DIMBLK', code: 342, kind: 'arrow', imp: '', met: '', since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Both (when not separate)', r12code: 5 },
  { name: 'DIMSAH', code: 173, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Separate first/second arrows' },
  { name: 'DIMASZ', code: 41, kind: 'dist', imp: 0.18, met: 2.5, since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Arrow size' },
  { name: 'DIMTSZ', code: 142, kind: 'dist', imp: 0, met: 0, since: 'AC1009', tab: 'Symbols and Arrows', group: 'Arrowheads', label: 'Tick size (0 = use arrows)' },
  { name: 'DIMCEN', code: 141, kind: 'dist', imp: 0.09, met: 2.5, since: 'AC1009', tab: 'Symbols and Arrows', group: 'Center marks', label: 'Size (0 none, >0 mark, <0 line)' },
  { name: 'DIMARCSYM', code: 90, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Symbols and Arrows', group: 'Arc length symbol', label: 'Arc length symbol',
    options: [[0, 'Preceding dimension text'], [1, 'Above dimension text'], [2, 'None']] },
  { name: 'DIMJOGANG', code: 50, kind: 'real', imp: Math.PI / 4, met: Math.PI / 4, since: 'AC1021', tab: 'Symbols and Arrows', group: 'Radius jog dimension', label: 'Jog angle (°)' },

  // ---- Text ------------------------------------------------------------------------------------
  { name: 'DIMTXSTY', code: 340, kind: 'style', imp: 'Standard', met: 'Standard', since: 'AC1015', tab: 'Text', group: 'Text appearance', label: 'Text style' },
  { name: 'DIMCLRT', code: 178, kind: 'color', imp: 0, met: 0, since: 'AC1009', tab: 'Text', group: 'Text appearance', label: 'Text color' },
  { name: 'DIMTFILL', code: 69, kind: 'enum', imp: 0, met: 0, since: 'AC1021', tab: 'Text', group: 'Text appearance', label: 'Fill',
    options: [[0, 'None'], [1, 'Background'], [2, 'Color']] },
  { name: 'DIMTFILLCLR', code: 70, kind: 'color', imp: 0, met: 0, since: 'AC1021', tab: 'Text', group: 'Text appearance', label: 'Fill color' },
  { name: 'DIMTXT', code: 140, kind: 'dist', imp: 0.18, met: 2.5, since: 'AC1009', tab: 'Text', group: 'Text appearance', label: 'Text height' },
  { name: 'DIMTFAC', code: 146, kind: 'real', imp: 1, met: 1, since: 'AC1009', tab: 'Text', group: 'Text appearance', label: 'Fraction / tolerance height scale' },
  { name: 'DIMTAD', code: 77, kind: 'enum', imp: 0, met: 1, since: 'AC1009', tab: 'Text', group: 'Text placement', label: 'Vertical',
    options: [[0, 'Centered'], [1, 'Above'], [2, 'Outside'], [3, 'JIS'], [4, 'Below']] },
  { name: 'DIMJUST', code: 280, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Text', group: 'Text placement', label: 'Horizontal',
    options: [[0, 'Centered'], [1, 'At Ext Line 1'], [2, 'At Ext Line 2'], [3, 'Over Ext Line 1'], [4, 'Over Ext Line 2']] },
  { name: 'DIMGAP', code: 147, kind: 'dist', imp: 0.09, met: 0.625, since: 'AC1009', tab: 'Text', group: 'Text placement', label: 'Offset from dim line (negative = frame)' },
  { name: 'DIMTIH', code: 73, kind: 'bool', imp: 1, met: 0, since: 'AC1009', tab: 'Text', group: 'Text alignment', label: 'Horizontal inside' },
  { name: 'DIMTOH', code: 74, kind: 'bool', imp: 1, met: 0, since: 'AC1009', tab: 'Text', group: 'Text alignment', label: 'Horizontal outside' },

  // ---- Fit -------------------------------------------------------------------------------------
  { name: 'DIMATFIT', code: 289, kind: 'enum', imp: 3, met: 3, since: 'AC1015', tab: 'Fit', group: 'Fit options', label: 'If there isn\'t enough room, move out',
    options: [[3, 'Either text or arrows (best fit)'], [1, 'Arrows'], [2, 'Text'], [0, 'Both text and arrows']] },
  { name: 'DIMTIX', code: 174, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Fit', group: 'Fit options', label: 'Always keep text between ext lines' },
  { name: 'DIMSOXD', code: 175, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Fit', group: 'Fit options', label: 'Suppress arrows if they don\'t fit inside' },
  { name: 'DIMTMOVE', code: 279, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Fit', group: 'Text placement', label: 'When text is not in the default position, place it',
    options: [[0, 'Beside the dimension line'], [1, 'Over the dimension line, with leader'], [2, 'Over the dimension line, without leader']] },
  { name: 'DIMSCALE', code: 40, kind: 'real', imp: 1, met: 1, since: 'AC1009', tab: 'Fit', group: 'Scale for dimension features', label: 'Use overall scale of' },
  { name: 'DIMUPT', code: 288, kind: 'bool', imp: 0, met: 0, since: 'AC1015', tab: 'Fit', group: 'Fine tuning', label: 'Place text manually' },
  { name: 'DIMTOFL', code: 172, kind: 'bool', imp: 0, met: 1, since: 'AC1009', tab: 'Fit', group: 'Fine tuning', label: 'Draw dim line between ext lines' },

  // ---- Primary Units ---------------------------------------------------------------------------
  { name: 'DIMLUNIT', code: 277, kind: 'enum', imp: 2, met: 2, since: 'AC1015', tab: 'Primary Units', group: 'Linear dimensions', label: 'Unit format',
    options: [[1, 'Scientific'], [2, 'Decimal'], [3, 'Engineering'], [4, 'Architectural'], [5, 'Fractional'], [6, 'Windows Desktop']] },
  { name: 'DIMDEC', code: 271, kind: 'enum', imp: 4, met: 2, since: 'AC1015', tab: 'Primary Units', group: 'Linear dimensions', label: 'Precision',
    options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n ? '0.' + '0'.repeat(n) : '0'] as [number, string]) },
  { name: 'DIMFRAC', code: 276, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Primary Units', group: 'Linear dimensions', label: 'Fraction format',
    options: [[0, 'Horizontal'], [1, 'Diagonal'], [2, 'Not stacked']] },
  { name: 'DIMDSEP', code: 278, kind: 'enum', imp: 46, met: 46, since: 'AC1015', tab: 'Primary Units', group: 'Linear dimensions', label: 'Decimal separator',
    options: [[46, "'.' (Period)"], [44, "',' (Comma)"], [32, "' ' (Space)"]] },
  { name: 'DIMRND', code: 45, kind: 'real', imp: 0, met: 0, since: 'AC1009', tab: 'Primary Units', group: 'Linear dimensions', label: 'Round off' },
  { name: 'DIMPOST', code: 3, kind: 'string', imp: '', met: '', since: 'AC1009', tab: 'Primary Units', group: 'Linear dimensions', label: 'Prefix / suffix (<> = value)' },
  { name: 'DIMLFAC', code: 144, kind: 'real', imp: 1, met: 1, since: 'AC1009', tab: 'Primary Units', group: 'Measurement scale', label: 'Scale factor' },
  { name: 'DIMZIN', code: 78, kind: 'int', imp: 0, met: 8, since: 'AC1009', tab: 'Primary Units', group: 'Zero suppression', label: 'Zero suppression flags' },
  { name: 'DIMAUNIT', code: 275, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Primary Units', group: 'Angular dimensions', label: 'Units format',
    options: [[0, 'Decimal Degrees'], [1, 'Degrees Minutes Seconds'], [2, 'Gradians'], [3, 'Radians']] },
  { name: 'DIMADEC', code: 179, kind: 'enum', imp: 0, met: 0, since: 'AC1015', tab: 'Primary Units', group: 'Angular dimensions', label: 'Precision',
    options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n ? '0.' + '0'.repeat(n) : '0'] as [number, string]) },
  { name: 'DIMAZIN', code: 79, kind: 'int', imp: 0, met: 0, since: 'AC1015', tab: 'Primary Units', group: 'Angular dimensions', label: 'Zero suppression flags' },

  // ---- Alternate Units -------------------------------------------------------------------------
  { name: 'DIMALT', code: 170, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Alternate Units', group: 'Alternate units', label: 'Display alternate units' },
  { name: 'DIMALTU', code: 273, kind: 'enum', imp: 2, met: 2, since: 'AC1015', tab: 'Alternate Units', group: 'Alternate units', label: 'Unit format',
    options: [[1, 'Scientific'], [2, 'Decimal'], [3, 'Engineering'], [4, 'Architectural'], [5, 'Fractional'], [6, 'Windows Desktop']] },
  { name: 'DIMALTD', code: 171, kind: 'enum', imp: 2, met: 3, since: 'AC1009', tab: 'Alternate Units', group: 'Alternate units', label: 'Precision',
    options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n ? '0.' + '0'.repeat(n) : '0'] as [number, string]) },
  { name: 'DIMALTF', code: 143, kind: 'real', imp: 25.4, met: 0.0393700787, since: 'AC1009', tab: 'Alternate Units', group: 'Alternate units', label: 'Multiplier for alt units' },
  { name: 'DIMALTRND', code: 148, kind: 'real', imp: 0, met: 0, since: 'AC1015', tab: 'Alternate Units', group: 'Alternate units', label: 'Round distances to' },
  { name: 'DIMAPOST', code: 4, kind: 'string', imp: '', met: '', since: 'AC1009', tab: 'Alternate Units', group: 'Alternate units', label: 'Prefix / suffix ([] = value; \\X at start = below primary)' },
  { name: 'DIMALTZ', code: 285, kind: 'int', imp: 0, met: 0, since: 'AC1015', tab: 'Alternate Units', group: 'Zero suppression', label: 'Zero suppression flags' },

  // ---- Tolerances ------------------------------------------------------------------------------
  { name: 'DIMTOL', code: 71, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Tolerances', group: 'Tolerance format', label: 'Tolerances on (symmetrical / deviation)' },
  { name: 'DIMLIM', code: 72, kind: 'bool', imp: 0, met: 0, since: 'AC1009', tab: 'Tolerances', group: 'Tolerance format', label: 'Limits' },
  { name: 'DIMTDEC', code: 272, kind: 'enum', imp: 4, met: 2, since: 'AC1015', tab: 'Tolerances', group: 'Tolerance format', label: 'Precision',
    options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n ? '0.' + '0'.repeat(n) : '0'] as [number, string]) },
  { name: 'DIMTP', code: 47, kind: 'real', imp: 0, met: 0, since: 'AC1009', tab: 'Tolerances', group: 'Tolerance format', label: 'Upper value' },
  { name: 'DIMTM', code: 48, kind: 'real', imp: 0, met: 0, since: 'AC1009', tab: 'Tolerances', group: 'Tolerance format', label: 'Lower value' },
  { name: 'DIMTOLJ', code: 283, kind: 'enum', imp: 1, met: 0, since: 'AC1015', tab: 'Tolerances', group: 'Tolerance format', label: 'Vertical position',
    options: [[0, 'Bottom'], [1, 'Middle'], [2, 'Top']] },
  { name: 'DIMTZIN', code: 284, kind: 'int', imp: 0, met: 8, since: 'AC1015', tab: 'Tolerances', group: 'Zero suppression', label: 'Zero suppression flags' },
  { name: 'DIMALTTD', code: 274, kind: 'enum', imp: 2, met: 3, since: 'AC1015', tab: 'Tolerances', group: 'Alternate unit tolerance', label: 'Precision',
    options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, n ? '0.' + '0'.repeat(n) : '0'] as [number, string]) },
  { name: 'DIMALTTZ', code: 286, kind: 'int', imp: 0, met: 0, since: 'AC1015', tab: 'Tolerances', group: 'Alternate unit tolerance', label: 'Zero suppression flags' },
];

export const VAR_BY_NAME = new Map(DIM_VARS.map((v) => [v.name, v]));
export const VAR_BY_CODE = new Map(DIM_VARS.map((v) => [v.code, v]));

export const TABS: Tab[] = ['Lines', 'Symbols and Arrows', 'Text', 'Fit', 'Primary Units', 'Alternate Units', 'Tolerances'];

/** AutoCAD's predefined arrowheads: block name ('' = closed filled) and dialog label. */
export const ARROWS: [string, string][] = [
  ['', 'Closed filled'], ['_CLOSEDBLANK', 'Closed blank'], ['_CLOSED', 'Closed'], ['_DOT', 'Dot'],
  ['_ARCHTICK', 'Architectural tick'], ['_OBLIQUE', 'Oblique'], ['_OPEN', 'Open'], ['_ORIGIN', 'Origin indicator'],
  ['_ORIGIN2', 'Origin indicator 2'], ['_OPEN90', 'Right angle'], ['_OPEN30', 'Open 30'], ['_DOTSMALL', 'Dot small'],
  ['_DOTBLANK', 'Dot blank'], ['_SMALL', 'Dot small blank'], ['_BOXBLANK', 'Box'], ['_BOXFILLED', 'Box filled'],
  ['_DATUMBLANK', 'Datum triangle'], ['_DATUMFILLED', 'Datum triangle filled'], ['_INTEGRAL', 'Integral'], ['_NONE', 'None'],
];

/** Lineweights offered in the dialog (1/100 mm; -1 ByLayer, -2 ByBlock, -3 Default). */
export const LINEWEIGHTS = [-2, -1, -3, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

/** Zero-suppression bits used by DIMZIN / DIMALTZ / DIMTZIN (and DIMAZIN uses 1 = leading, 2 = trailing). */
export const ZIN_BITS = {
  /** linear: low two bits choose feet/inches suppression; 4 = leading zeros; 8 = trailing zeros */
  leading: 4,
  trailing: 8,
} as const;
