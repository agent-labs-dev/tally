#!/usr/bin/env python3
"""Regenerate the wordmarks in assets/: the tally-mark tile from logo.svg beside "tally" in Liberation Sans outlines."""

import re
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = TTFont("/usr/share/fonts/liberation/LiberationSans-BoldItalic.ttf")
INK, PAPER = "#17150f", "#f5f2ea"
OUT = Path(__file__).parent.parent / "assets"
LOGO = (OUT / "logo.svg").read_text()
MARKS = re.search(r"<g[^>]*>.*</g>", LOGO, re.S).group(0)
LOGO_BOX = re.search(r'viewBox="([^"]+)"', LOGO).group(1)

HEIGHT, TILE, GAP, SIZE, BASELINE = 100, 84, 18, 76, 77


def text(word: str, x: float, ink: str) -> tuple[str, float]:
    glyphs = FONT.getGlyphSet()
    scale = SIZE / FONT["head"].unitsPerEm
    parts = []
    for char in word:
        name = FONT.getBestCmap()[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, BASELINE)))
        parts.append(f'<path d="{pen.getCommands()}" fill="{ink}"/>')
        x += glyphs[name].width * scale
    return "".join(parts), x


def wordmark(tile: str, marks: str, ink: str) -> str:
    top = (HEIGHT - TILE) / 2
    icon = (
        f'<svg x="8" y="{top}" width="{TILE}" height="{TILE}" viewBox="{LOGO_BOX}" aria-hidden="true">'
        f'<rect width="1024" height="1024" rx="200" fill="{tile}"/>'
        f"{MARKS.replace('#f5f2ea', marks)}</svg>"
    )
    word, end = text("tally", 8 + TILE + GAP, ink)
    width = end + 10
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.2f} {HEIGHT}" role="img" aria-label="tally">'
        f"<title>tally</title>{icon}{word}</svg>\n"
    )


(OUT / "wordmark.svg").write_text(wordmark(INK, PAPER, INK))
(OUT / "wordmark-dark.svg").write_text(wordmark(PAPER, INK, PAPER))
