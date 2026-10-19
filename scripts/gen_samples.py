"""Generate deterministic coverage drawings with ezdxf (independent DXF implementation).

Usage: .venv/Scripts/python -I scripts/gen_samples.py <out_dir>
"""
import math
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import Vec2, Vec3

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "public/samples")
OUT.mkdir(parents=True, exist_ok=True)


def setup(doc):
    doc.layers.add("GEOM", color=7)
    doc.layers.add("RED", color=1, linetype="DASHED")
    doc.layers.add("TEXT", color=3)
    doc.layers.add("HATCH", color=4)
    doc.layers.add("BLOCKS", color=5)
    doc.layers.add("OFF_LAYER", color=6).off()
    doc.layers.add("FROZEN", color=2).freeze()
    doc.layers.add("DIMS", color=2)


def basic(version="R2018"):
    doc = ezdxf.new(version, setup=True)
    setup(doc)
    msp = doc.modelspace()
    msp.add_line((0, 0), (100, 0), dxfattribs={"layer": "GEOM"})
    msp.add_line((0, 0), (0, 60), dxfattribs={"layer": "RED"})
    msp.add_line((0, 60), (100, 60), dxfattribs={"layer": "GEOM", "color": 1, "lineweight": 50})
    msp.add_line((100, 0), (100, 60), dxfattribs={"layer": "GEOM", "linetype": "CENTER", "true_color": 0xFF8800})
    msp.add_circle((50, 30), 20, dxfattribs={"layer": "GEOM", "color": 4})
    msp.add_arc((50, 30), 25, 30, 150, dxfattribs={"layer": "GEOM", "color": 6})
    msp.add_ellipse((150, 30), major_axis=(30, 10), ratio=0.4, dxfattribs={"layer": "GEOM"})
    msp.add_ellipse((150, 80), major_axis=(0, 20), ratio=0.5, start_param=0, end_param=math.pi,
                    dxfattribs={"layer": "GEOM", "color": 2})
    msp.add_lwpolyline([(0, 80, 0, 0, 0.5), (30, 80, 0, 0, 0), (30, 110, 0, 0, -1), (0, 110)],
                       format="xyseb", close=True, dxfattribs={"layer": "GEOM", "color": 5})
    msp.add_lwpolyline([(40, 80), (70, 90), (60, 110)], dxfattribs={"const_width": 2.0, "color": 30})
    msp.add_lwpolyline([(80, 80, 0, 4), (110, 80, 4, 0)], format="xyse", dxfattribs={"color": 140})
    msp.add_polyline2d([(120, 120), (140, 140), (160, 120)], dxfattribs={"color": 3})
    msp.add_polyline3d([(170, 120, 0), (190, 140, 10), (210, 120, 5)], dxfattribs={"color": 210})
    msp.add_spline([(0, 130), (20, 150), (40, 120), (60, 160), (80, 130)], dxfattribs={"color": 1})
    msp.add_open_spline([(100, 160), (120, 190), (140, 150), (160, 190)], degree=3, dxfattribs={"color": 3})
    msp.add_point((90, 30), dxfattribs={"color": 1})
    msp.add_solid([(200, 0), (240, 0), (200, 30), (240, 30)], dxfattribs={"color": 8})
    msp.add_3dface([(200, 40), (240, 40), (240, 70), (200, 70)], dxfattribs={"color": 9})
    msp.add_line((0, -20), (100, -20), dxfattribs={"layer": "OFF_LAYER"})
    msp.add_line((0, -25), (100, -25), dxfattribs={"layer": "FROZEN"})
    # OCS circle on a tilted plane and a mirrored arc (extrusion 0,0,-1)
    msp.add_circle((10, 10, 0), 5, dxfattribs={"extrusion": (0, 1, 1), "color": 2})
    msp.add_arc((-60, -30, 0), 10, 0, 90, dxfattribs={"extrusion": (0, 0, -1), "color": 1})
    msp.add_xline((-50, -50), (1, 1), dxfattribs={"color": 251})
    msp.add_ray((-50, 200), (1, 0), dxfattribs={"color": 251})
    return doc


def text_doc():
    doc = ezdxf.new("R2018", setup=True)
    setup(doc)
    msp = doc.modelspace()
    msp.add_text("Left baseline", height=5, dxfattribs={"layer": "TEXT"}).set_placement((0, 0))
    msp.add_text("Center", height=5, rotation=30, dxfattribs={"layer": "TEXT"}).set_placement(
        (60, 0), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text("Right top", height=3, dxfattribs={"style": "OpenSans"}).set_placement(
        (150, 0), align=TextEntityAlignment.TOP_RIGHT)
    msp.add_text("Diameter %%c50, 90%%d, %%p0.1", height=4).set_placement((0, -15))
    msp.add_text("Wide", height=6, dxfattribs={"width": 2.0}).set_placement((0, -30))
    mt = msp.add_mtext(
        "{\\fArial|b1;Bold title}\\P"
        "Normal line with \\C1;red\\C256; word and \\H2x;big\\H0.5x; text.\\P"
        "A long paragraph that should wrap inside the reference rectangle width set on the entity.",
        dxfattribs={"char_height": 3, "width": 60, "layer": "TEXT"})
    mt.set_location((0, 60), attachment_point=1)
    mt2 = msp.add_mtext("Middle center\\Psecond line", dxfattribs={"char_height": 4, "rotation": 15})
    mt2.set_location((120, 60), attachment_point=5)
    msp.add_mtext("Unicode: Ä ö ß Ω 中文", dxfattribs={"char_height": 4}).set_location((0, 90))
    return doc


def blocks_doc():
    doc = ezdxf.new("R2018", setup=True)
    setup(doc)
    flag = doc.blocks.new("FLAG", base_point=(0, 0))
    flag.add_line((0, 0), (0, 10))                                 # layer 0, BYLAYER
    flag.add_lwpolyline([(0, 10), (6, 8), (0, 6)], close=True, dxfattribs={"color": 0})  # BYBLOCK
    flag.add_circle((0, 0), 1, dxfattribs={"color": 1})            # explicit red
    flag.add_attdef("NAME", (1, 0), dxfattribs={"height": 1.5})
    nested = doc.blocks.new("TWOFLAGS", base_point=(5, 0))
    nested.add_blockref("FLAG", (0, 0))
    nested.add_blockref("FLAG", (10, 0), dxfattribs={"xscale": -1})
    msp = doc.modelspace()
    msp.add_blockref("FLAG", (0, 0), dxfattribs={"layer": "BLOCKS"})
    msp.add_blockref("FLAG", (20, 0), dxfattribs={"layer": "RED", "color": 3, "rotation": 45})
    ref = msp.add_blockref("FLAG", (40, 0), dxfattribs={"xscale": 2, "yscale": 2})
    ref.add_auto_attribs({"NAME": "Big flag"})
    msp.add_blockref("TWOFLAGS", (70, 0), dxfattribs={"color": 6})
    arr = msp.add_blockref("FLAG", (0, 40), dxfattribs={"color": 30})
    arr.dxf.column_count = 4
    arr.dxf.row_count = 3
    arr.dxf.column_spacing = 12
    arr.dxf.row_spacing = 15
    msp.add_blockref("FLAG", (120, 0), dxfattribs={"layer": "OFF_LAYER"})
    msp.add_blockref("FLAG", (130, 0), dxfattribs={"layer": "FROZEN"})
    msp.add_blockref("FLAG", (150, 0), dxfattribs={"extrusion": (0, 0, -1)})
    return doc


def hatch_doc():
    doc = ezdxf.new("R2018", setup=True)
    setup(doc)
    msp = doc.modelspace()
    h = msp.add_hatch(color=1)
    h.paths.add_polyline_path([(0, 0), (40, 0), (40, 30), (0, 30)], is_closed=True)
    h.paths.add_polyline_path([(10, 10), (30, 10), (30, 20), (10, 20)], is_closed=True)
    h2 = msp.add_hatch(color=3)
    h2.set_pattern_fill("ANSI31", scale=0.5)
    h2.paths.add_polyline_path([(50, 0), (90, 0), (90, 30, 1), (50, 30)], is_closed=True)
    h3 = msp.add_hatch(color=5)
    h3.set_pattern_fill("BRICK", scale=0.2, angle=15)
    ep = h3.paths.add_edge_path()
    ep.add_line((100, 0), (140, 0))
    ep.add_arc((140, 15), 15, -90, 90)
    ep.add_line((140, 30), (100, 30))
    ep.add_ellipse((100, 15), major_axis=(0, 15), ratio=0.5, start_angle=0, end_angle=180)
    h4 = msp.add_hatch(color=4)
    h4.set_pattern_fill("NET", scale=0.5)
    ep2 = h4.paths.add_edge_path()
    ep2.add_spline(control_points=[(0, 50), (20, 80), (40, 40), (60, 70)], degree=3)
    ep2.add_line((60, 70), (0, 50))
    h5 = msp.add_hatch()
    h5.set_gradient((255, 0, 0), (0, 0, 255))
    h5.paths.add_polyline_path([(100, 50), (140, 50), (120, 80)], is_closed=True)
    return doc


DIM_OV = {"dimtxt": 2.5, "dimlfac": 1, "dimasz": 2.5, "dimexe": 1.25, "dimexo": 0.625, "dimgap": 0.625, "dimtsz": 0}


def dims_doc():
    doc = ezdxf.new("R2018", setup=True)
    setup(doc)
    msp = doc.modelspace()
    msp.add_line((0, 0), (50, 0))
    msp.add_line((50, 0), (50, 30))
    d = msp.add_linear_dim(base=(0, -10), p1=(0, 0), p2=(50, 0), dimstyle="EZDXF", override=DIM_OV, dxfattribs={"layer": "DIMS"})
    d.render()
    d = msp.add_aligned_dim(p1=(50, 0), p2=(50, 30), distance=10, dimstyle="EZDXF", override=DIM_OV, dxfattribs={"layer": "DIMS"})
    d.render()
    msp.add_circle((100, 15), 15)
    d = msp.add_radius_dim(center=(100, 15), radius=15, angle=45, dimstyle="EZ_RADIUS", override=DIM_OV)
    d.render()
    d = msp.add_diameter_dim(center=(100, 15), radius=15, angle=135, dimstyle="EZ_RADIUS", override=DIM_OV)
    d.render()
    d = msp.add_angular_dim_2l(base=(30, 50), line1=((0, 40), (40, 40)), line2=((0, 40), (30, 70)), dimstyle="EZ_CURVED", override=DIM_OV)
    d.render()
    msp.add_leader([(150, 0), (160, 20), (175, 20)])
    ml = msp.add_multileader_mtext("Standard")
    ml.set_content("MLeader")
    from ezdxf.render.mleader import ConnectionSide
    ml.add_leader_line(ConnectionSide.left, [Vec2(140, 40)])
    ml.build(insert=Vec2(155, 50))
    return doc


def mesh_doc():
    doc = ezdxf.new("R2018", setup=True)
    msp = doc.modelspace()
    mesh = msp.add_polymesh(size=(4, 4))
    for m in range(4):
        for n in range(4):
            mesh.set_mesh_vertex((m, n), (m * 10, n * 10, math.sin(m + n) * 3))
    pf = msp.add_polyface()
    pf.append_face([(50, 0, 0), (70, 0, 0), (70, 20, 0), (50, 20, 0)])
    pf.append_face([(50, 0, 0), (70, 0, 0), (60, 10, 15)])
    msp.add_3dface([(100, 0, 0), (120, 0, 0), (110, 20, 5)])
    cube(msp, (140, 0, 0), 15, color=4)
    # thickness extrudes 2D entities along their normal
    msp.add_circle((200, 10), 8, dxfattribs={"thickness": 12, "color": 2})
    msp.add_lwpolyline([(220, 0), (240, 0), (240, 15), (220, 15)], close=True, dxfattribs={"thickness": 6, "color": 3})
    msp.add_line((250, 0), (270, 20), dxfattribs={"thickness": 10, "color": 6})
    # 3D polyline helix
    msp.add_polyline3d([(300 + 10 * math.cos(t / 8), 10 + 10 * math.sin(t / 8), t * 0.6) for t in range(100)], dxfattribs={"color": 1})
    return doc


def cube(msp, origin, size, color=7):
    """A MESH (AcDbSubDMesh) box: 8 vertices, 6 quad faces. `size` is a number or (sx, sy, sz)."""
    x, y, z = origin
    sx, sy, sz = size if isinstance(size, tuple) else (size, size, size)
    mesh = msp.add_mesh(dxfattribs={"color": color})
    with mesh.edit_data() as data:
        data.vertices = [(x, y, z), (x + sx, y, z), (x + sx, y + sy, z), (x, y + sy, z),
                         (x, y, z + sz), (x + sx, y, z + sz), (x + sx, y + sy, z + sz), (x, y + sy, z + sz)]
        data.faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return mesh


def house_doc():
    """A small house: 3DFACE walls with a door opening, polyface roof, MESH chimney,
    thick lines as a fence, text on a wall plane. Saved in SW isometric view."""
    doc = ezdxf.new("R2018", setup=True)
    doc.layers.add("WALLS", color=7)
    doc.layers.add("ROOF", color=1)
    doc.layers.add("CHIMNEY", color=8)
    doc.layers.add("FENCE", color=3)
    doc.layers.add("FLOOR", color=252)
    doc.layers.add("NOTES", color=2)
    msp = doc.modelspace()
    W, D, H = 40, 30, 20
    # floor
    msp.add_3dface([(0, 0, 0), (W, 0, 0), (W, D, 0), (0, D, 0)], dxfattribs={"layer": "FLOOR"})
    # front wall (y = 0) split around a door 16..24 wide, 0..14 high; inner joins invisible
    wall = {"layer": "WALLS"}
    msp.add_3dface([(0, 0, 0), (16, 0, 0), (16, 0, H), (0, 0, H)], dxfattribs={**wall, "invisible_edges": 0b0100})
    msp.add_3dface([(24, 0, 0), (W, 0, 0), (W, 0, H), (24, 0, H)], dxfattribs={**wall, "invisible_edges": 0b0100})
    msp.add_3dface([(16, 0, 14), (24, 0, 14), (24, 0, H), (16, 0, H)], dxfattribs={**wall, "invisible_edges": 0b0100})
    msp.add_3dface([(W, 0, 0), (W, D, 0), (W, D, H), (W, 0, H)], dxfattribs=wall)
    msp.add_3dface([(W, D, 0), (0, D, 0), (0, D, H), (W, D, H)], dxfattribs=wall)
    msp.add_3dface([(0, D, 0), (0, 0, 0), (0, 0, H), (0, D, H)], dxfattribs=wall)
    # gable roof as a polyface mesh: two slopes + two gable triangles
    R = 12
    pf = msp.add_polyface(dxfattribs={"layer": "ROOF"})
    pf.append_face([(-2, -2, H), (W + 2, -2, H), (W + 2, D / 2, H + R), (-2, D / 2, H + R)])
    pf.append_face([(-2, D + 2, H), (W + 2, D + 2, H), (W + 2, D / 2, H + R), (-2, D / 2, H + R)])
    pf.append_face([(0, 0, H), (0, D, H), (0, D / 2, H + R)])
    pf.append_face([(W, 0, H), (W, D, H), (W, D / 2, H + R)])
    # chimney (MESH)
    cube(msp, (28, 4, H + 2), (4, 4, 14), color=256).dxf.layer = "CHIMNEY"  # pokes through the roof
    # fence of thick lines
    for i in range(6):
        msp.add_line((-15, -10 + i * 9), (-15, -10 + (i + 1) * 9), dxfattribs={"layer": "FENCE", "thickness": 6})
    msp.add_line((-15, -10), (55, -10), dxfattribs={"layer": "FENCE", "thickness": 6})
    # a round window on the right wall: circle in the wall's plane (extrusion +X)
    msp.add_circle((15, 12, W + 0.01), 3, dxfattribs={"layer": "WALLS", "extrusion": (1, 0, 0), "color": 5})
    # house number on the front wall: text in the XZ plane (extrusion -Y)
    t = msp.add_text("No. 42", height=2.5, dxfattribs={"layer": "NOTES", "extrusion": (0, -1, 0)})
    # OCS for extrusion (0,-1,0): X axis = (-1,0,0)? use ezdxf to place it at WCS (5, 0, 16)
    from ezdxf.math import OCS
    t.set_placement(OCS((0, -1, 0)).from_wcs((5, -0.01, 16)))
    msp.add_text("3D house sample", height=3, dxfattribs={"layer": "NOTES"}).set_placement((0, -20))
    vp = doc.viewports.get("*Active")[0]
    vp.dxf.direction = (-1, -1, 1)
    vp.dxf.target = (W / 2, D / 2, H / 2)
    return doc


def r12_doc():
    doc = ezdxf.new("R12", setup=True)
    doc.layers.add("R12LAYER", color=2)
    msp = doc.modelspace()
    msp.add_line((0, 0), (50, 50), dxfattribs={"layer": "R12LAYER"})
    msp.add_circle((25, 25), 10)
    msp.add_polyline2d([(0, 0, 0, 0, 0.5), (50, 0), (50, 20)], format="xyseb")
    msp.add_text("R12 text", height=3).set_placement((0, 60))
    blk = doc.blocks.new("BOX")
    blk.add_polyline2d([(0, 0), (5, 0), (5, 5), (0, 5)], close=True)
    msp.add_blockref("BOX", (60, 0), dxfattribs={"xscale": 2, "rotation": 10})
    return doc


def big_doc(n=20000):
    doc = ezdxf.new("R2018")
    msp = doc.modelspace()
    import random
    rnd = random.Random(42)
    for i in range(n):
        x, y = rnd.uniform(0, 2000), rnd.uniform(0, 2000)
        if i % 3 == 0:
            msp.add_circle((x, y), rnd.uniform(1, 10), dxfattribs={"color": rnd.randint(1, 255)})
        else:
            msp.add_line((x, y), (x + rnd.uniform(-20, 20), y + rnd.uniform(-20, 20)),
                         dxfattribs={"color": rnd.randint(1, 255)})
    return doc


def ucs_dims_doc():
    """A plate away from the WCS origin with a saved UCS at its corner (for ordinate dimensions)."""
    doc = ezdxf.new("R2018", setup=True)
    doc.header["$DIMSTYLE"] = "Standard"
    doc.layers.add("PART", color=7)
    doc.layers.add("HOLES", color=4)
    msp = doc.modelspace()
    ox, oy = 200, 100
    msp.add_lwpolyline([(ox, oy), (ox + 120, oy), (ox + 120, oy + 80), (ox, oy + 80)], close=True, dxfattribs={"layer": "PART"})
    for (x, y, r) in [(20, 20, 6), (100, 20, 6), (100, 60, 6), (20, 60, 6), (60, 40, 15)]:
        msp.add_circle((ox + x, oy + y), r, dxfattribs={"layer": "HOLES"})
    msp.add_arc((ox + 60, oy + 80), 10, 180, 360, dxfattribs={"layer": "PART"})
    msp.add_line((ox + 120, oy + 80), (ox + 150, oy + 110), dxfattribs={"layer": "PART"})
    doc.ucs.new("PART", dxfattribs={"origin": (ox, oy, 0), "xaxis": (1, 0, 0), "yaxis": (0, 1, 0)})
    doc.header["$UCSORG"] = (ox, oy, 0)
    doc.header["$UCSXDIR"] = (1, 0, 0)
    doc.header["$UCSYDIR"] = (0, 1, 0)
    doc.header["$UCSNAME"] = "PART"
    return doc


SAMPLES = {
    "basic_entities.dxf": basic,
    "basic_entities_r2000.dxf": lambda: basic("R2000"),
    "text_mtext.dxf": text_doc,
    "blocks_inserts.dxf": blocks_doc,
    "hatches.dxf": hatch_doc,
    "dimensions_leaders.dxf": dims_doc,
    "meshes_3d.dxf": mesh_doc,
    "house_3d.dxf": house_doc,
    "ucs_dims.dxf": ucs_dims_doc,
    "r12_legacy.dxf": r12_doc,
    "stress_20k.dxf": big_doc,
}

for name, fn in SAMPLES.items():
    doc = fn()
    doc.header["$INSUNITS"] = 4
    doc.saveas(OUT / name)
    print("wrote", OUT / name)
