"""Reference renderings with ezdxf's drawing add-on (independent renderer) for visual comparison.

Usage: .venv/Scripts/python -I scripts/ref_render.py <out_dir> file.dxf [...]
"""
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import ezdxf
from ezdxf.addons.drawing import RenderContext, Frontend
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for f in sys.argv[2:]:
    doc = ezdxf.readfile(f)
    fig = plt.figure(figsize=(10, 6.5), dpi=110)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_facecolor("#212830"); fig.patch.set_facecolor("#212830")
    Frontend(RenderContext(doc), MatplotlibBackend(ax)).draw_layout(doc.modelspace(), finalize=True)
    name = Path(f).stem
    fig.savefig(out / f"ref_{name}.png", facecolor="#212830")
    plt.close(fig)
    print("rendered", name)
