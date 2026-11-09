# Max Slicer

A resin slicer for two printers, chosen at the top right:

| Printer | LCD | Pixel | Build volume | Print file |
|---|---|---|---|---|
| Anycubic Photon Mono M7 Max | 6480 × 3600 | 46 µm | 298 × 164 × 300 mm | `.pm7m` |
| Elegoo Saturn 4 Ultra 16K | 15120 × 6230 | 14 × 19 µm | 211.68 × 118.37 × 220 mm | `.goo` (V3) |

Each resin profile belongs to one printer; switching printer switches to that printer's profiles and plate.

## Install (Windows 10/11, 64-bit)

- **Max-Slicer-Setup-1.1.0.exe**: installer (choose a folder, desktop shortcut, opens `.pm7m` and `.m7proj` files).
- **Max-Slicer-Portable-1.1.0.exe**: no installation; run it from any folder or a USB stick.

Neither file is code-signed, so Windows SmartScreen will warn the first time. Choose **More info → Run anyway**.

## Workflow

The four steps along the top follow the order you print in.

1. **Prepare.** Open STL, OBJ or 3MF files (or drag them onto the plate). Meshes are repaired on load: holes closed, flipped faces fixed, inside-out shells turned. Move, rotate and scale with the gizmo (T / R / S) or type exact values. Other tools: mirror, *Lay flat on face*, *Auto-orient* (balanced, fewer supports, lower height or less peel force), duplicate, arrange.
2. **Hollow.** Set the wall thickness, optionally with a cubic or gyroid infill lattice. *Auto-place drain holes* puts a hole under every pocket of the cavity that would otherwise seal. If the part sits on the plate, it uses side holes instead, because the plate would block a bottom hole. *Check suction & trapped resin* marks cups that seal against the FEP and closed cavities.
3. **Supports.** Light, medium and heavy presets, all adjustable: tip diameter, tip length, contact depth, trunk and base diameter, overhang angle, spacing, density and model elevation. Raft (slab with chamfer), cross braces, and supports that rest on the model when the plate is out of reach. *Auto-support* checks its own result: it runs an island check that includes the supports and adds more until nothing floats. *Add supports* / *Remove supports* work by clicking; *Check islands* shows anything unsupported.
4. **Slice.** Resin profiles hold layer height, bottom layers, exposures, transition layers, waits, lift and retract (two-stage motion optional), anti-aliasing (2×, 4×, 8×), blur, density and price. *Slice plate* uses every CPU core. Layer view shows each LCD image as the printer will show it; click it for a 1:1 pixel inspection. *Export* writes the print file for the selected printer.

Other features: project files (`.m7proj`) keep models, supports, holes and hollowing; *Export STL* writes the plate with supports; *Open print file* lets you inspect any existing `.pm7m` or `.goo` (V3), including Lychee's. Shortcuts: Ctrl+Z / Ctrl+Y undo/redo, Ctrl+D duplicate, Del delete, F fit view, X X-ray, Esc ends a tool. The interface is available in English and Serbian (EN / SR, top right).

For the Saturn 4 Ultra 16K the default profile **Saturn 16K 100um** carries the values from your Lychee export *deolik.goo*: 0.1 mm layers, 6 bottom layers at 25 s, 3.2 s normal exposure, 6 transition layers, 15 s / 1 s wait before cure, and lift values of 0 (the tilting vat is driven by the printer's firmware).

For the M7 Max the default resin profile **r65** carries the exact values from your Lychee export *Miki_za_resin3.pm7m*: 0.05 mm layers, 10 bottom layers at 90 s, 4.3 s normal exposure, 10 transition layers, a 3 s light-off delay, 4 mm at 2 mm/s bottom lift, and 8 mm at 6 mm/s normal lift.

## How the print file was verified

- The `.pm7m` structure was reverse-engineered from your Lychee Slicer 8 export and cross-checked against UVtools' open-source implementation. Every JSON key and its order, the binary `scene.slice` layout, ZIP entry order and the PW0 layer encoding match. The resin settings written by default are identical to your file, as are all 12,786 per-layer values (exposure, height, lift).
- LCD orientation follows UVtools' M7 Max profile (X mirrored). Comparing your file's layers with Lychee's own preview shows the same handedness, so parts come out the right way round, not mirrored.
- Slicing accuracy: edges land on the exact expected pixel, overlapping parts are merged (never cancelled), and resin volume matches analytic volume within 0.4 %. Hollow walls measured 1.98–2.19 mm for a 2 mm setting.
- Saturn `.goo`: the GOO V3 layout was read from your Lychee export and cross-checked against UVtools. All 543 layers of your file decode and re-encode byte-identical with this slicer's encoder; generated files match your file in every printer field (resolution, display size, mirror flags, delay mode, PWM, layer-table address) and every layer passes its checksum. The 14 × 19 µm grid is pixel-exact (a 20 mm cube is 1428 × 1052 px). The time estimate reproduces Lychee's 2911 s for your file exactly.
- `test/verify_pm7m.py` and `test/verify_goo.py` independently decodes every layer of an exported file and checks it against the reference structure.

## Not included

From Lychee Slicer Plus, as agreed: no FDM and no model libraries. Also not in this version: cut / split with connector keys, tree or branching supports, lattice raft, measuring tool, text embossing, mesh decimation, and cloud or printer-network features.

The print-time estimate assumes constant motion speeds. The printer recalculates time itself, so its figure can differ.

## Building from source

Requires Node.js 20+. On Windows, double-click `build-windows.bat`, or run:

```
npm install
npm run dist:win      # installer + portable exe in release/
npm start             # run without packaging
npm test              # engine tests
```

Source layout: `src/core` holds the slicing engine (mesh repair, rasteriser, PW0 and GOO encoders, `.pm7m` and `.goo` writers, supports, hollowing, analysis, orientation), `src/renderer` the interface, `src/main` the Electron shell.
