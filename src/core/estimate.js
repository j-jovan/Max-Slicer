// Print time / material estimates.
import { effectiveExposure } from './pm7m.js';

function moveTime(dist, v, acc) {
  if (dist <= 0 || v <= 0) return 0;
  if (!acc || acc <= 0) return dist / v;
  // trapezoidal profile
  const dAcc = (v * v) / acc; // accel + decel distance
  if (dist >= dAcc) return dist / v + v / acc;
  return 2 * Math.sqrt(dist / acc);
}

// Seconds for one layer (exposure + waits + peel/retract motion).
export function layerTime(p, k, accel = 0) {
  const bottom = k < p.bottomLayers;
  const exp = effectiveExposure(p, k);
  const wb = bottom ? p.bottomWaitBeforeCure : p.waitBeforeCure;
  const wa = bottom ? p.bottomWaitAfterCure : p.waitAfterCure;
  const wl = bottom ? p.bottomWaitAfterLift : p.waitAfterLift;
  let motion;
  if (p.twoStage) {
    const h1 = bottom ? p.bottomLiftHeight : p.liftHeight, h2 = bottom ? p.bottomLiftHeight2 : p.liftHeight2;
    const u1 = bottom ? p.bottomLiftSpeed : p.liftSpeed, u2 = bottom ? p.bottomLiftSpeed2 : p.liftSpeed2;
    const d1 = bottom ? p.bottomRetractSpeed : p.retractSpeed, d2 = bottom ? p.bottomRetractSpeed2 : p.retractSpeed2;
    motion = moveTime(h1, u1, accel) + moveTime(h2, u2, accel) + moveTime(h2, d2, accel) + moveTime(h1, d1, accel);
  } else {
    const h = bottom ? p.bottomLiftHeight : p.liftHeight;
    motion = moveTime(h, bottom ? p.bottomLiftSpeed : p.liftSpeed, accel) + moveTime(h, bottom ? p.bottomRetractSpeed : p.retractSpeed, accel);
  }
  return wb + exp + wa + motion + wl;
}

// overhead: fixed seconds per layer the firmware adds (e.g. a tilting vat)
export function printTime(p, layerCount, accel = 0, overhead = 0) {
  let t = 0;
  for (let k = 0; k < layerCount; k++) t += layerTime(p, k, accel) + overhead;
  return t;
}

export function formatDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s).padStart(2, '0')} s`;
}
