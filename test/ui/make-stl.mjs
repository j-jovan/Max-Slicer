import fs from 'node:fs';
import { loadMeshFile, transformTris, bounds, toBinarySTL, repairMesh } from '../../src/core/mesh.js';
const [src, dst, size] = process.argv.slice(2);
let t = repairMesh(loadMeshFile(src, fs.readFileSync(src).buffer)[0].tris).tris;
const b = bounds(t); const s = +size / Math.max(b.max[1] - b.min[1], 1e-9);
t = transformTris(t, [s,0,0,0, 0,0,s,0, 0,-s,0,0, 0,0,0,1]); // Y-up -> Z-up
fs.writeFileSync(dst, toBinarySTL(t));
console.log(dst, t.length / 9, 'tris');
