# thinkAbuild

A 3D structural sandbox for Windows. You draw shapes, give each one a real material, and the app works out whether the structure stands or collapses. Every change is checked live by a structural solver. **Simulate** then lets rigid-body physics play out the result: overloaded parts snap, shatter, crumble, crush or bend depending on what they are made of.

## Run it

| What | How |
| --- | --- |
| Install | `release\thinkAbuild-Setup-1.0.0.exe` |
| No install | `release\thinkAbuild-Portable-1.0.0.exe` |
| Develop (hot reload) | `npm install`, then `npm run app:dev` |
| Run the built app | `npm run app` |
| Rebuild the .exe files | `npm run dist` (output in `release/`) |
| Tests | `npm test` (solver checked against textbook results and every example) |

## Using it

- **Draw**: Box `B`, Cylinder `C`, Ball `O`, Beam `L` (a member between two points, for braces and trusses). Click to start, click to set the base, move to set the height, click again to finish. Shapes snap to the grid, to part corners and face centres, and to the face under the cursor. A post extruded towards a part above snaps up to touch it.
- **Draw from any angle**: orbit with right-drag (left-drag in Select mode), pan with middle-drag, zoom with the scroll wheel. Use the view buttons (3D, Top, Front, Right, Left, Back, orthographic). The plane menu switches between *Faces + floor*, a *Horizontal plane* (which sees through parts, so you can draw under a table top), a *Front plane (XY)* and a *Side plane (YZ)*, each with an adjustable offset.
- **Edit**: select a part and it shows move arrows and rotation rings together: drag an arrow (or the square between two) to move it, drag a ring to turn it in 15° steps. `G` / `R` show or hide the arrows / rings. Or type exact sizes, positions and angles in the right panel. `Ctrl+D` duplicates, `Del` deletes, `Ctrl+Z`/`Ctrl+Y` undo and redo.
- **Materials**: 30 real materials (woods, metals, stone, glass, plastics, foam, rubber). Click one to apply it to the selected part or to use it for new parts. Hover over a material to see its properties.
- **Joints**: parts that touch are glued by default. Per contact you can choose *Resting*, *Glued*, *Screwed*, *Bolted*, *Welded* or *Unbreakable*. Ticking **Fixed to the world** turns a part into a wall or foundation.
- **Live verdict**: the pill at the top says whether the structure stands, and gives the safety factor or what fails first and why. **Stress** colours every part by utilisation. The bending menu shows true-scale or exaggerated deflection.
- **Simulate** (`Space`): watch it play out. Slow motion is available, and **Throw** hurls a 5 kg steel ball wherever you click. The event log explains every failure.

## Workshop tools

The **Workshop** panel (top left) holds tools that act on what you have built. Most of them also work while the simulation runs.

| Tool | Key | What it does |
| --- | --- | --- |
| **Saw** | `S` | Cuts any part in two. Point at a face and the blade goes in there. By default it cuts square across the part; `R` turns the cut 90° (a rip along the part), `Q` / `E` angle it in 15° steps (mitres, wedges, corners off). The preview shows the cut face and both piece lengths, snapped to the grid. Square cuts leave plain boxes and cylinders; angled cuts are kept as exact cut planes on the shape, so the solver still treats a mitred leg as a beam. |
| **Hammer** | `H` | Claw hammer, club hammer or sledgehammer. Swings at the part you click (starting the simulation if needed) and goes through the same impact physics as a falling part. |
| **Push** | `P` | Drag a part around in a running simulation, up to 600 N. A sustained push is checked as a load, so pushing hard enough breaks things. |
| **Throw** | `T` | Throws a 5 kg steel ball at 24 m/s. |
| **Glue / Screws / Bolts / Weld** | `J` | Click where two parts touch to join them that way. Dots mark every contact, coloured by its joint, and the label shows what the new joint will hold. Welding needs metal on both sides. |
| **Pry bar** | | Separates joined parts (they keep resting on each other). In a running simulation it breaks the joint live. |
| **Tape** | `M` | Measures between two points, snapping to corners and face centres. |
| **Round** | `E` | Rounds over or bevels edges, like running a router round them. Drag an edge inwards to round it, outwards to square it again. Corners (a table top seen from above, or the long edges of a leg) go all four together, or one at a time with Shift. A rim (the edge round a top or bottom face) goes all the way round, following rounded corners. Push a square top's corners right in and it becomes a disc. Exact sizes go in the **Edges** section of the right panel. |

Rounded edges are real geometry everywhere. The physics hull, contacts, mass and the structural model all use them, so a fully rounded leg has the area and stiffness of a round one. Sawing a rounded part keeps its rounded edges, and the cut face is square.

Cutting follows the material:

- **Tool and kerf:** the app uses the right tool for each material. Wood gets a hand saw (1.5 mm kerf, sawdust). Steel, stainless, cast iron, titanium and tungsten get an angle grinder (2 mm). Its sparks are orange for steel, white for titanium and dull red for tungsten. Soft metals get a hacksaw (bright shavings, no sparks), stone and concrete a diamond blade (dust), and foam and rubber a knife.
- **Glass:** annealed glass is scored and snapped. Tempered glass refuses to be cut. Scored during a simulation, it bursts into cubes, as it does in real life.
- **Grain:** a cut piece keeps its wood grain direction, so a thin slice off a leg shows end grain.
- **Cutting time:** depends on the material and the area cut. Tungsten is slow going.

**Sawing a loaded part while simulating** is checked continuously. The internal forces where the blade is cutting come from the structural solver, and the uncut material is checked against them as it shrinks. A plank carrying a weight creaks and then gives way before the blade gets through (in the test scene, 85% of the way through, which matches a hand calculation). A post in pure compression can be sawn right through. The cut closes up and the post still carries the load, until something knocks it sideways.

## The physics, honestly

**Structural solver** (`src/fea`): a 3D finite-element frame analysis that runs on every change.

- **Members**: beams and columns are Timoshenko frame elements. Slabs and panels are plate grillages. Chunky blocks and balls are rigid bodies.
- **Contacts**: resting contacts are compression-only and can lift off or rock, which is solved with an active-set iteration. Glued, screwed, bolted and welded joints also carry tension and shear up to their capacity.
- **Stability**: a linear buckling eigen-analysis, then a second-order pass with initial imperfections. This pass catches sway buckling and bases that rock under load, which is why slender table legs fail long before the wood crushes.
- **Material checks**: tension, compression, bending, shear and torsion. Wood is weaker across the grain. Concrete and glass are weak in tension. Ductile metals reach full plastic moment and then yield.
- **Contact checks**: bearing pressure (crushing) at contacts, punching shear through plates, and Hertz contact stress under balls.

The solver is checked by `npm test` against cantilever and simply-supported beam theory, Euler buckling, rigid-body dynamics (inertia relief) and point compliance.

**Simulation** (`src/sim`): Rapier rigid-body physics.

- Glued assemblies move as one rigid body until something breaks. Breaking splits the body and passes each joint on to the fragment that holds it.
- Any assembly at rest is re-checked by the structural solver.
- For impacts, the peak force comes from the impulse, the contact stiffness and the struck structure's measured flexibility, and is capped by local crushing. That force is then put through the same checks.
- Failure styles follow the material: wood snaps and splinters, glass shatters (tempered glass into cubes), concrete and stone crumble, metals form plastic hinges and fold, and foam crushes.

**Limits**: the solver is linear elastic (it is accurate for small deflections and flags anything larger). It does not model creep, fatigue, temperature or wind. Materials use typical published values, not lab-perfect ones. The outcome depends on the real dimensions you draw. Four stout wooden legs really can carry a thin tungsten slab. The *Tungsten slab on 4 pine legs* example is sized so that they cannot.

## Project layout

```
src/core     design model, 30 materials, joints, contact detection, shape geometry, saw cuts
src/fea      sparse solver, frame elements, model builder, analysis and checks
src/sim      Rapier simulation, fracture geometry
src/render   viewport, procedural PBR textures, part meshes, deformation, particles
src/tools    drawing, selection and workshop tools (saw, hammer, joining, tape, hand), tool models
src/ui       toolbar, workshop, materials, inspector, overlays
electron     Windows app shell (file dialogs, window)
test         solver and example tests
```
