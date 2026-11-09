// Anycubic Photon Mono M7 Max machine definition.
// Values verified against a Lychee-exported .pm7m (machine_type block) and
// the UVtools M7 Max printer profile (display 298.08 x 165.6 mm, mirror X).

export const M7MAX = Object.freeze({
  name: 'Anycubic Photon Mono M7 Max',
  extension: 'pm7m',
  resX: 6480,
  resY: 3600,
  pixelMm: 0.046,               // 46 µm square pixels
  displayW: 6480 * 0.046,       // 298.08 mm physical LCD width
  displayH: 3600 * 0.046,       // 165.6 mm physical LCD height
  printW: 297.5,                // usable area reported by the machine profile
  printH: 164,
  maxZ: 300,
  // LCD image = mirror of the top view (verified: UVtools profile display_mirror_x = 1,
  // display_mirror_y = 0, landscape, with PrusaSlicer's implicit top-left raster origin).
  mirrorX: true,
  previewSizes: [[224, 168], [336, 252]],
});

// Convert build-plate millimetres (origin = plate centre, +X right, +Y back)
// to continuous LCD pixel coordinates (u = column, v = row).
export function mmToPixel(x, y, p = M7MAX) {
  const u = (p.displayW / 2 - x) / p.pixelMm;   // mirrored X
  const v = (p.displayH / 2 - y) / p.pixelMm;   // image rows grow toward the front
  return [u, v];
}

export function pixelToMm(u, v, p = M7MAX) {
  return [p.displayW / 2 - u * p.pixelMm, p.displayH / 2 - v * p.pixelMm];
}

// Default resin profile = the user's own profile found in their Lychee export ("r65").
export const DEFAULT_PROFILE = Object.freeze({
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
