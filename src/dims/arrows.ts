/**
 * AutoCAD's predefined dimension arrowheads, as geometry in a unit frame:
 * the tip is at (0, 0), the arrow's body extends along +x (toward the dimension line's inside),
 * and 1 unit = the arrow size (DIMASZ). Builders transform these into the drawing.
 */
export type Pt = [number, number];

export type ArrowPart =
  | { k: 'line'; a: Pt; b: Pt }
  | { k: 'solid'; pts: Pt[] } // filled triangle or quad
  | { k: 'circle'; c: Pt; r: number }
  | { k: 'disk'; c: Pt; r: number } // filled circle
  | { k: 'thick'; a: Pt; b: Pt; w: number }; // a wide line (architectural tick)

const T = 1 / 6; // half-width of AutoCAD's closed arrows (width = 1/3 of the length)

function outline(pts: Pt[]): ArrowPart[] {
  return pts.map((p, i) => ({ k: 'line', a: p, b: pts[(i + 1) % pts.length] }) as ArrowPart);
}

/** Geometry of an arrow block by name ('' = closed filled). */
export function arrowParts(name: string): ArrowPart[] {
  switch (name.toUpperCase()) {
    case '':
    case '_CLOSEDFILLED':
      return [{ k: 'solid', pts: [[0, 0], [1, T], [1, -T]] }];
    case '_CLOSEDBLANK':
      return outline([[0, 0], [1, T], [1, -T]]);
    case '_CLOSED':
      return [...outline([[0, 0], [1, T], [1, -T]]), { k: 'line', a: [0, 0], b: [1, 0] }];
    case '_OPEN':
      return [{ k: 'line', a: [0, 0], b: [1, T] }, { k: 'line', a: [0, 0], b: [1, -T] }];
    case '_OPEN30': {
      const t = Math.tan((15 * Math.PI) / 180);
      return [{ k: 'line', a: [0, 0], b: [1, t] }, { k: 'line', a: [0, 0], b: [1, -t] }];
    }
    case '_OPEN90':
      return [{ k: 'line', a: [0, 0], b: [0.5, 0.5] }, { k: 'line', a: [0, 0], b: [0.5, -0.5] }];
    case '_DOT':
      return [{ k: 'disk', c: [0, 0], r: 0.25 }];
    case '_DOTSMALL':
      return [{ k: 'disk', c: [0, 0], r: 0.0625 }];
    case '_DOTBLANK':
      return [{ k: 'circle', c: [0, 0], r: 0.25 }];
    case '_SMALL':
      return [{ k: 'circle', c: [0, 0], r: 0.125 }];
    case '_ORIGIN':
      return [{ k: 'circle', c: [0, 0], r: 0.5 }];
    case '_ORIGIN2':
      return [{ k: 'circle', c: [0, 0], r: 0.5 }, { k: 'circle', c: [0, 0], r: 0.25 }];
    case '_ARCHTICK':
      return [{ k: 'thick', a: [-0.5, -0.5], b: [0.5, 0.5], w: 0.15 }];
    case '_OBLIQUE':
      return [{ k: 'line', a: [-0.5, -0.5], b: [0.5, 0.5] }];
    case '_BOXBLANK':
      return outline([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]);
    case '_BOXFILLED':
      return [{ k: 'solid', pts: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }];
    case '_DATUMBLANK':
      return outline([[0, 0.5774], [1, 0], [0, -0.5774]]);
    case '_DATUMFILLED':
      return [{ k: 'solid', pts: [[0, 0.5774], [1, 0], [0, -0.5774]] }];
    case '_INTEGRAL': {
      // an integral sign across the tip: two quarter arcs forming an S
      const pts: Pt[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = (i / 12) * Math.PI;
        pts.push([0.15 * Math.sin(t) * (i < 6 ? -1 : 1), -0.5 + i / 12]);
      }
      return pts.slice(1).map((p, i) => ({ k: 'line', a: pts[i], b: p }));
    }
    case '_NONE':
      return [];
    default:
      // unknown user block: draw as closed filled so the dimension stays readable
      return [{ k: 'solid', pts: [[0, 0], [1, T], [1, -T]] }];
  }
}

/** Arrow types drawn as ticks across the line (the dimension line then runs to/through them). */
export function isTick(name: string): boolean {
  return ['_ARCHTICK', '_OBLIQUE', '_INTEGRAL', '_NONE', '_DOT', '_DOTSMALL', '_DOTBLANK', '_SMALL', '_ORIGIN', '_ORIGIN2', '_BOXBLANK', '_BOXFILLED'].includes(name.toUpperCase());
}
