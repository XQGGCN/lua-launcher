"""Rebuild Lua's flat vector icon as desktop packaging assets (requires Pillow)."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
SCALE = 4


def box(coordinates):
    return tuple(value * SCALE for value in coordinates)


# Coordinates and colors intentionally match icon.svg, the editable source.
canvas = Image.new("RGBA", (1024 * SCALE, 1024 * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle(
    box((26, 26, 998, 998)), radius=222 * SCALE, fill="#d3dfe8"
)
draw.rounded_rectangle(
    box((38, 38, 986, 986)), radius=210 * SCALE, fill="#f1f5f8"
)
mask = Image.new("L", canvas.size, 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.ellipse(box((224, 248, 768, 792)), fill=255)
mask_draw.ellipse(box((368, 164, 860, 656)), fill=0)
canvas.paste("#437cae", (0, 0, *canvas.size), mask)
icon = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(ROOT / "icon.png", optimize=True)
icon.save(
    ROOT / "icon.ico",
    format="ICO",
    sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)],
)

# Pillow includes the standard 1x/2x macOS resolutions, up to 1024 pixels.
icon.save(ROOT / "icon.icns", format="ICNS")

print("Generated icon.png, icon.ico, and icon.icns")
