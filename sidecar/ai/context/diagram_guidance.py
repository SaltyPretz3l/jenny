"""Which diagram language the system prompt teaches.

Exactly one of three texts reaches the prompt, never two: the short sketch grammar
(the default), the full sketch grammar, or the Mermaid line the prompt always carried.
The flag ``sketch_blocks`` and the setting ``drawing_instructions`` choose.

The two sketch texts were probed on the owner's local models and are kept character for
character. They are plain constants because the sidecar is frozen for packaging: nothing
here reads a data file at run time.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.feature_flags import FEATURE_SKETCH_BLOCKS, is_default_on_flag_enabled

# Diagrams are drawn from a fenced block in the reply, not from a tool. Always in the
# prompt, with or without tools, so the model never reaches for one.
MERMAID_GUIDANCE = (
    "## Diagrams\n"
    "To show a diagram, put Mermaid code in a fenced code block tagged mermaid "
    "in your reply; the chat draws it as a chart."
)

DIAGRAM_GUIDANCE_VARIANTS = ("mermaid", "sketch_short", "sketch_full")

SKETCH_SHORT_GUIDANCE = """\
## Diagrams
To show a diagram, write a fenced code block tagged sketch in your reply, exactly as in the example; the chat lays it out and draws it. Without the sketch tag nothing is drawn. One element per line, no positions:
title <text>
dir right|down
group <id> <label>
<id> <label> [@icon] [(cylinder|person|note|circle)] [in <group id>] [!accent] [~ hover text]
<a> -> <b> [label]   (--> is a dashed arrow, <-> points both ways)
step <title>: <text> | <ids to highlight>
An id is one word of letters, digits, _ or -. Give every node its own line before an arrow or step names it. Use 3 to 12 nodes, labels of 1 to 4 words and 3 to 7 steps. To change a drawing, write the whole block again with the same ids.
Example:
```sketch
title Sign in
user User (person)
api API @server
db Accounts (cylinder)
user -> api password
api -> db look up
step Check: The API looks the user up | api db
```"""  # noqa: E501

SKETCH_FULL_GUIDANCE = """\
## Diagrams
To show a diagram, write a fenced code block tagged sketch in your reply, exactly as in the example; the chat lays it out and draws it. Without the sketch tag nothing is drawn. One element per line, no positions:
title <text>
dir right|down
group <id> <label>
<id> <label> [@icon] [(cylinder|person|note|circle)] [in <group id>] [!accent] [~ hover text]
<a> -> <b> [label]   (--> is a dashed arrow, <-> points both ways)
step <title>: <text> | <ids to highlight>
An id is one word of letters, digits, _ or -. Give every node its own line before an arrow or step names it. Use 3 to 12 nodes, labels of 1 to 4 words and 3 to 7 steps. To change a drawing, write the whole block again with the same ids.
Example:
```sketch
title Sign in
user User (person)
api API @server
db Accounts (cylinder)
user -> api password
api -> db look up
step Check: The API looks the user up | api db
```
More blocks, each on its own lines inside the same sketch block:
draw <id> [WxH] [in <group>] [: title]   (free drawing on its own canvas, default 100x100, y down; the shape lines follow, later lines paint on top)
  circle [name] x,y r | ellipse [name] x,y rx ry | rect [name] x,y w h (x,y = top left)
  line|arrow|curve [name] x,y x,y \u2026 | shape|blob [name] x,y x,y x,y \u2026 (closed; curve and blob are smooth)
  arc [name] x,y r from to (degrees, 0 = right, counter-clockwise) | text [name] x,y words [size=14]
  object <type> [name] x,y [size] [rotate=45] [flip]   (types: person, tree, cloud, house, car, bike, gear, sun, bulb, battery, laptop, phone, server, book, heart, drop, flame, mountain, flask, rocket, lock, key) | icon [name] x,y <lucide name> [size]
  repeat i=0..7: <shape line>   (i in coordinates, {i+1} in names and labels)
  let w = 84-12*a   (names a sub-expression for the lines below; keeps long coordinates short)
  angle [name] x,y cx,cy x,y [r] (arc at the middle point; 90\u00b0 gets the square) | measure [name] x,y x,y [offset] (dimension line)
  brace [name] x,y x,y [depth] (curly brace, bulging to the right of the way) | axes [name] x,y w h [ticks=10] [~ x name | y name] (x,y = origin) | grid [name] x,y w h [step]
  slider a 0..1 [= 0] [hidden]   (before the shapes using it; coordinates may use a, the reader gets a control unless hidden)
  Options: fill=<color> hatch=<color> color=<color> width=2 --dashed arrow both !accent !muted stage=2 along=<shape name>@<0..1> move=<dx>,<dy> ~ label
  Colors: black gray white accent yellow blue red green purple orange. Coordinates may be math: 50+30*cos(1),50. Use ~ label instead of text wherever you can: Sketchy places labels clear of the drawing. $x^2$ works in labels.
  In steps: "| pic[name]" circles a named shape; "pic=2" shows only shapes up to stage 2, so a picture can build up (start with pic=1); "a=0.5" glides a slider there, which is how things move. Draw a moving shape at its start and shift it with move=40*a,0; a shape with along=wire@a rides on the shape named wire, its own x,y being an offset (usually 0,0). Every step should end in a clear picture: move things all the way, one idea per step, never stop a motion halfway.
timeline|cycle|pyramid|funnel|venn|matrix|mindmap <id> [in <group>] [: title]   (ready-made explanation shapes; entries follow, one per line, a blank line ends them; end an entry with !accent, !muted or ~ small print)
  timeline: <when> | <what>   cycle, pyramid (top first), funnel (top first): <entry>
  mindmap: <centre>, then - <branch>, -- <sub-branch>
  venn: set a Cats, set b Dogs, then a | purrs, a,b | pets   (2 or 3 sets)
  matrix: cols Option | Price | Speed, then Cheap | 1 \u20ac | slow
  In steps: "| t[2]" circles the 2nd entry, "t=2" shows only the first 2.
molecule <id> <SMILES> [full] [in <group>] [: title]   (structural formula, e.g. CCO, c1ccccc1, CC(=O)O; full writes out every C and H; steps circle atoms as m[3], counted in SMILES order)
map <id> [world|europe|africa|asia|middle-east|north-america|south-america|americas|oceania|<country>|west,south,east,north] [: title]   (lines follow, a blank line ends them)
  <English country name> [fill=<color>|hatch=<color>|!accent] [~ label] | place [name] lat,lon [label] [!accent] | route [name:] <place|lat,lon> -> <place|lat,lon> [--dashed] [~ label]
  In steps: "| m[Germany]" or "m[United-Kingdom]" circles a country, "m[berlin]" a place or route."""  # noqa: E501


_GUIDANCE_BY_VARIANT = {
    "mermaid": MERMAID_GUIDANCE,
    "sketch_short": SKETCH_SHORT_GUIDANCE,
    "sketch_full": SKETCH_FULL_GUIDANCE,
}


def resolve_diagram_guidance(variant: str) -> str:
    """The prompt text for a variant; an unknown value gives the Mermaid text."""
    if isinstance(variant, str):
        return _GUIDANCE_BY_VARIANT.get(variant, MERMAID_GUIDANCE)
    return MERMAID_GUIDANCE


def diagram_guidance_kwargs(config: Any) -> dict[str, str]:
    """``build_system_prompt`` kwargs naming the one diagram language for this config.

    Shared by every prompt-build call site so a live turn, the context preview and an
    approval resume agree. A config without either attribute counts as flag on and the
    ``short`` setting.
    """
    flags = getattr(config, "feature_flags", None)
    if not is_default_on_flag_enabled(flags, FEATURE_SKETCH_BLOCKS):
        return {"diagram_guidance": "mermaid"}
    setting = getattr(config, "drawing_instructions", "short")
    if setting == "mermaid":
        return {"diagram_guidance": "mermaid"}
    if setting == "full":
        return {"diagram_guidance": "sketch_full"}
    return {"diagram_guidance": "sketch_short"}
