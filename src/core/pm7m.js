// .pm7m (Anycubic Photon Workshop "PWSZ" ZIP container) writer and reader.
// Structure reproduced from a Lychee Slicer 8 export for the M7 Max and cross-checked
// against UVtools' AnycubicZipFile implementation.
import TEMPLATE from './pwsp_template.js';
import { M7MAX } from './printer.js';
import { buildZip, readZip, packEntry } from './zip.js';
import { decodePW0 } from './pw0.js';

export const APP_MARK = 'Max Slicer';
export const APP_VERSION = '1.0.0';

const te = new TextEncoder();
const json = (o) => te.encode(JSON.stringify(o, null, '\t').replace(/\n/g, '\r\n'));
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function layerExposure(profile, k) {
  return k < profile.bottomLayers ? profile.bottomExposure : profile.exposure;
}

// Exposure the firmware will actually apply when it honours transition layers
// (UVtools' linear rule). Used for time estimates only.
export function effectiveExposure(profile, k) {
  const b = profile.bottomLayers, t = profile.transitionLayers | 0;
  if (k < b) return profile.bottomExposure;
  if (t > 0 && k < b + t) {
    const dec = (profile.bottomExposure - profile.exposure) / (t + 1);
    return profile.bottomExposure - dec * (k - b + 1);
  }
  return profile.exposure;
}

function resinEntry(p, aa) {
  const tpl = TEMPLATE.machine_extern.user_resins[0];
  return {
    version: '2',
    property: {
      version: '3',
      code: '10',
      currency: p.currencyCode || 'EUR',
      name: p.name,
      price: r6(p.pricePerLitre),
      type: 'Resin',
      volume: 1000,
      subfunc_code: 0,
      target_temperature: 25,
      density: r6(p.density),
    },
    slicepara: {
      anti_count: aa,
      blur_level: 0,
      gray_level: 0,
      bott_layers: p.bottomLayers,
      bott_time: r6(p.bottomExposure),
      exposure_time: r6(p.exposure),
      off_time: r6(p.waitBeforeCure),
      use_indivi_layerpara: 0,
      use_random_erode: 0,
      zdown_speed: r6(p.retractSpeed),
      zthick: r6(p.layerHeight),
      zup_height: r6(p.liftHeight),
      zup_speed: r6(p.liftSpeed),
      wait_before_lift: r6(p.waitAfterCure),
      wait_after_lift: r6(p.waitAfterLift),
      bott_off_time: r6(p.bottomWaitBeforeCure),
      bott_wait_before_lift: r6(p.bottomWaitAfterCure),
      bott_wait_after_lift: r6(p.bottomWaitAfterLift),
    },
    slice_extpara: {
      version: '3',
      multi_state_used: p.twoStage ? 1 : 0,
      transition_layercount: p.transitionLayers | 0,
      transition_type: 0,
      intelli_mode: p.intelliMode ?? 1,
      max_acceleration: p.maxAcceleration ?? 2,
      exposure_compensate: 0,
      separate_support_exposure_delayed: 0,
      multi_state_paras: {
        bott_0: { down_speed: r6(p.bottomRetractSpeed), height: r6(p.bottomLiftHeight), up_speed: r6(p.bottomLiftSpeed) },
        bott_1: { down_speed: r6(p.bottomRetractSpeed2), height: r6(p.bottomLiftHeight2), up_speed: r6(p.bottomLiftSpeed2) },
        normal_0: { down_speed: r6(p.retractSpeed), height: r6(p.liftHeight), up_speed: r6(p.liftSpeed) },
        normal_1: { down_speed: r6(p.retractSpeed2), height: r6(p.liftHeight2), up_speed: r6(p.liftSpeed2) },
      },
    },
    depth_penetration_curve: JSON.parse(JSON.stringify(tpl.depth_penetration_curve)),
  };
}

export function buildSettings(profile, aa) {
  const s = JSON.parse(JSON.stringify(TEMPLATE));
  const mt = s.machine_type;
  mt.res_x = M7MAX.resX; mt.res_y = M7MAX.resY;
  mt.child_screen = [{ x: 0, y: 0, width: M7MAX.resX, height: M7MAX.resY }];
  s.machine_extern.user_resins = [resinEntry(profile, aa)];
  s.machine_extern.active_resins = [profile.name];
  return s;
}

export function buildLayersController(profile, layerCount) {
  const paras = [];
  const h = profile.layerHeight;
  for (let k = 0; k < layerCount; k++) {
    const bottom = k < profile.bottomLayers;
    paras.push({
      exposure_time: r6(layerExposure(profile, k)),
      layer_index: k,
      layer_minheight: r6(k * h),
      layer_thickness: r6(h),
      zup_height: r6(bottom ? profile.bottomLiftHeight : profile.liftHeight),
      zup_speed: r6(bottom ? profile.bottomLiftSpeed : profile.liftSpeed),
    });
  }
  return { count: layerCount, paras };
}

// stats[k] = {area, x0, y0, x1, y1, objects, maxArea}  (mm, offsets from display centre)
export function buildScene(profile, stats) {
  const n = stats.length;
  const buf = new ArrayBuffer(16 + 64 + 4 * 13 + 256 + 4 + 4 + n * 64 + 4);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set(te.encode('ANYCUBIC-PWSZ'), 0);
  // Software name field (64 bytes at 16) left empty, exactly as Lychee writes it.
  let o = 80;
  dv.setUint32(o, 3, true); o += 4;        // binary type: FPGA release
  dv.setUint32(o, 1, true); o += 4;        // version
  dv.setUint32(o, 0, true); o += 4;        // slice type
  dv.setUint32(o, 0, true); o += 4;        // model unit: mm
  dv.setFloat32(o, 1, true); o += 4;       // point ratio
  dv.setUint32(o, n, true); o += 4;        // layer count
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of stats) if (s.objects > 0) { x0 = Math.min(x0, s.x0); y0 = Math.min(y0, s.y0); x1 = Math.max(x1, s.x1); y1 = Math.max(y1, s.y1); }
  if (!isFinite(x0)) x0 = y0 = x1 = y1 = 0;
  dv.setFloat32(o, x0, true); o += 4;
  dv.setFloat32(o, y0, true); o += 4;
  dv.setFloat32(o, 0, true); o += 4;       // z min
  dv.setFloat32(o, x1, true); o += 4;
  dv.setFloat32(o, y1, true); o += 4;
  dv.setFloat32(o, n * profile.layerHeight, true); o += 4; // z max
  dv.setUint32(o, 0, true); o += 4;        // model stats
  o += 256;                                // padding
  u8.set(te.encode('<---'), o); o += 4;
  dv.setUint32(o, n, true); o += 4;
  for (let k = 0; k < n; k++) {
    const s = stats[k];
    dv.setFloat32(o, (k + 1) * profile.layerHeight, true);
    dv.setFloat32(o + 4, s.area, true);
    dv.setFloat32(o + 8, s.x0, true);
    dv.setFloat32(o + 12, s.y0, true);
    dv.setFloat32(o + 16, s.x1, true);
    dv.setFloat32(o + 20, s.y1, true);
    dv.setUint32(o + 24, s.objects, true);
    dv.setFloat32(o + 28, s.maxArea, true);
    o += 64;
  }
  u8.set(te.encode('--->'), o);
  return u8;
}

// ZIP entry order used by the reference file: ordinal compare of upper-cased names.
function sortNames(a, b) {
  const A = a.name.toUpperCase(), B = b.name.toUpperCase();
  return A < B ? -1 : A > B ? 1 : 0;
}

/**
 * Assemble a .pm7m file.
 * layers: array of packed entries {data, crc, size, method} for each PW0 layer image
 * previews: [png224x168, png336x252]
 * Returns array of Uint8Array chunks.
 */
export function buildPM7M({ profile, aa, layers, stats, previews, printTime, volumeMl }) {
  if (layers.length !== stats.length) throw new Error('layer/stat count mismatch');
  if (layers.length === 0) throw new Error('Nothing to print: no layers');
  const entries = [];
  entries.push({ name: 'anycubic_photon_resins.pwsp', ...packEntry(json(buildSettings(profile, aa))) });
  entries.push({ name: 'layers_controller.conf', ...packEntry(json(buildLayersController(profile, layers.length))) });
  layers.forEach((e, k) => entries.push({ name: `layer_images/layer_${k}.pw0Img`, ...e }));
  previews.forEach((png, i) => entries.push({ name: `preview_images/preview_${i}.png`, ...packEntry(png) }));
  const cost = (volumeMl / 1000) * profile.pricePerLitre;
  entries.push({ name: 'print_info.json', ...packEntry(json({ cost: r6(cost), currency: profile.currencyCode || 'EUR', print_time: Math.round(printTime), volume: Math.round(volumeMl) })) });
  entries.push({ name: 'scene.slice', ...packEntry(buildScene(profile, stats)) });
  entries.push({ name: 'software_info.conf', ...packEntry(json({ mark: APP_MARK, opengl: '3.3-CoreProfile', os: 'windows', version: APP_VERSION })) });
  entries.sort(sortNames);
  return buildZip(entries);
}

// ---------------------------------------------------------------- reader

const td = new TextDecoder();

export function readPM7M(u8) {
  const zip = readZip(u8);
  const need = ['anycubic_photon_resins.pwsp', 'layers_controller.conf', 'scene.slice'];
  for (const n of need) if (!zip.has(n)) throw new Error(`Not a valid .pm7m: missing ${n}`);
  const settings = JSON.parse(td.decode(zip.get('anycubic_photon_resins.pwsp').get()));
  const lc = JSON.parse(td.decode(zip.get('layers_controller.conf').get()));
  const scene = zip.get('scene.slice').get();
  const sdv = new DataView(scene.buffer, scene.byteOffset, scene.byteLength);
  const magic = td.decode(scene.subarray(0, 13));
  if (magic !== 'ANYCUBIC-PWSZ') throw new Error('Bad scene.slice magic');
  const layerCount = sdv.getUint32(100, true);
  const W = settings.machine_type.res_x, H = settings.machine_type.res_y;
  const layerName = (k) => (zip.has(`layer_images/layer_${k}.pw0Img`) ? `layer_images/layer_${k}.pw0Img` : `layer_images/layer_${k}.pwszImg`);
  const sceneLayers = [];
  for (let k = 0; k < sdv.getUint32(388 + 4, true); k++) {
    const o = 396 + k * 64;
    sceneLayers.push({ z: sdv.getFloat32(o, true), area: sdv.getFloat32(o + 4, true), objects: sdv.getUint32(o + 24, true) });
  }
  return {
    W, H, layerCount, settings, layersController: lc, sceneLayers, zip,
    printInfo: zip.has('print_info.json') ? JSON.parse(td.decode(zip.get('print_info.json').get())) : null,
    software: zip.has('software_info.conf') ? JSON.parse(td.decode(zip.get('software_info.conf').get())) : null,
    layerData: (k) => zip.get(layerName(k)).get(),
    layerImage(k) {
      const name = layerName(k);
      if (name.endsWith('pwszImg')) throw new Error('pwszImg layer encoding is not supported for preview');
      return decodePW0(zip.get(name).get(), W, H);
    },
  };
}
