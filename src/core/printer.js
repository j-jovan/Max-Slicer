// Supported printers. Each one maps build-plate millimetres (origin = plate centre,
// +X right, +Y back) to LCD pixels:  u = (displayW/2 + sx*x) / pixelX,
//                                     v = (displayH/2 + sy*y) / pixelY
// Both printers store the mirror of the top view (prints come out the right way round
// because the part hangs upside down from the plate).

// Anycubic Photon Mono M7 Max. Verified against a Lychee-exported .pm7m and the UVtools
// profile (display 298.08 x 165.6 mm, display_mirror_x = 1, PrusaSlicer raster origin).
export const M7MAX = Object.freeze({
  id: 'm7max',
  name: 'Anycubic Photon Mono M7 Max',
  format: 'pm7m',
  extension: 'pm7m',
  resX: 6480,
  resY: 3600,
  pixelMm: 0.046,
  pixelX: 0.046, pixelY: 0.046,   // 46 µm square pixels
  displayW: 6480 * 0.046,         // 298.08 mm
  displayH: 3600 * 0.046,         // 165.6 mm
  printW: 297.5,                  // usable area reported by the machine profile
  printH: 164,
  maxZ: 300,
  sx: -1, sy: -1,
  previewSizes: [[224, 168], [336, 252]],
  layerOverhead: 0,               // extra seconds per layer for the time estimate
});

// Elegoo Saturn 4 Ultra 16K. Verified against a Lychee 8 .goo export for this printer
// (GOO V3, 15120 x 6230, 211.68 x 118.37 mm, header MirrorY = 1).
export const SATURN4U16K = Object.freeze({
  id: 'saturn4u16k',
  name: 'Elegoo Saturn 4 Ultra 16K',
  format: 'goo',
  extension: 'goo',
  resX: 15120,
  resY: 6230,
  pixelMm: 0.014,
  pixelX: 0.014, pixelY: 0.019,   // 14 x 19 µm (non-square)
  displayW: 211.68,
  displayH: 118.37,
  printW: 211.68,
  printH: 118.37,
  maxZ: 220,
  sx: 1, sy: 1,                   // top view mirrored vertically (GOO MirrorY = 1)
  previewSizes: [[116, 116], [290, 290]],
  // tilt-release vat: the firmware moves on its own; calibrated so the estimate matches
  // Lychee's 2911 s for the reference file (543 layers)
  layerOverhead: 0.665,
});

export const PRINTERS = { [M7MAX.id]: M7MAX, [SATURN4U16K.id]: SATURN4U16K };

// Default resin profile = the user's own profile found in their Lychee export ("r65").
export const DEFAULT_PROFILE = Object.freeze({
  printer: 'm7max',
  name: 'r65',
  layerHeight: 0.05,
  bottomLayers: 10,
  bottomExposure: 90,
  exposure: 4.3,
  transitionLayers: 10,     // as in the reference Lychee export (written to the printer's resin settings)
  // Waits (seconds)
  bottomWaitBeforeCure: 0,
  bottomWaitAfterCure: 1,
  bottomWaitAfterLift: 1,
  waitBeforeCure: 3,       // "off_time" (light-off delay)
  waitAfterCure: 0,
  waitAfterLift: 0,
  // Lift (mm, mm/s)
  bottomLiftHeight: 4, bottomLiftSpeed: 2, bottomRetractSpeed: 2,
  liftHeight: 8, liftSpeed: 6, retractSpeed: 6,
  // Two-stage motion (TSMC)
  twoStage: false,
  bottomLiftHeight2: 4, bottomLiftSpeed2: 6, bottomRetractSpeed2: 6,
  liftHeight2: 5, liftSpeed2: 6, retractSpeed2: 6,
  // Image
  antiAliasing: 1,     // 1 = off, 2, 4, 8
  blur: 0,             // px radius of box blur applied after AA (0 = off)
  // Material
  density: 1.2,        // g/ml
  pricePerLitre: 40,
  currency: '€',
  // Firmware intelligent mode flags from the profile
  intelliMode: 1,
  maxAcceleration: 2,
});

// Saturn 4 Ultra 16K profile = the values in the user's Lychee .goo export.
// Lift/retract are 0: the tilting vat is driven by the firmware.
export const SATURN_PROFILE = Object.freeze({
  ...DEFAULT_PROFILE,
  printer: 'saturn4u16k',
  name: 'Saturn 16K 100um',
  layerHeight: 0.1,
  bottomLayers: 6,
  bottomExposure: 25,
  exposure: 3.2,
  transitionLayers: 6,
  bottomWaitBeforeCure: 15, bottomWaitAfterCure: 0, bottomWaitAfterLift: 0,
  waitBeforeCure: 1, waitAfterCure: 0, waitAfterLift: 0,
  bottomLiftHeight: 0, bottomLiftSpeed: 0, bottomRetractSpeed: 0,
  liftHeight: 0, liftSpeed: 0, retractSpeed: 0,
  bottomLiftHeight2: 0, bottomLiftSpeed2: 0, bottomRetractSpeed2: 0,
  liftHeight2: 0, liftSpeed2: 0, retractSpeed2: 0,
});

export const DEFAULT_PROFILES = { m7max: DEFAULT_PROFILE, saturn4u16k: SATURN_PROFILE };
