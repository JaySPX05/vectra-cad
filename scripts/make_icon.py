"""Draw the Vectra CAD app icon (build/icon.png, 512x512, and build/icon.ico).

Usage: .venv/Scripts/python -I scripts/make_icon.py
"""
from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=96, fill=(31, 111, 209, 255))
d.rounded_rectangle([16, 16, S - 16, S - 16], radius=96, outline=(13, 60, 130, 255), width=8)
W = (255, 255, 255, 255)
A = (255, 190, 60, 255)
# a drafted part: plate outline with a hole
d.rectangle([110, 150, 400, 330], outline=W, width=14)
d.ellipse([205, 190, 305, 290], outline=W, width=12)
# a dimension below it: extension lines, dimension line, arrows
d.line([110, 345, 110, 425], fill=A, width=8)
d.line([400, 345, 400, 425], fill=A, width=8)
d.line([125, 400, 385, 400], fill=A, width=8)
d.polygon([(110, 400), (150, 385), (150, 415)], fill=A)
d.polygon([(400, 400), (360, 385), (360, 415)], fill=A)
img.save("build/icon.png")
img.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote build/icon.png and build/icon.ico")
