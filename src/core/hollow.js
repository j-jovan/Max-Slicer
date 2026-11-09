// Hollowing: cavity = { p inside model : distance(p, surface) > wall }, extracted as a
// closed mesh (outward normals) that the slicer subtracts from the model.
import { bounds, signedVolume } from './mesh.js';
import { voxelize, distanceToOutside, surfaceNets } from './voxel.js';

export function computeCavity(tris, opts = {}) {
  const wall = opts.wall ?? 2;
  const maxVoxels = opts.maxVoxels ?? 24e6;
  const b = bounds(tris);
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  let vs = opts.voxel || Math.min(0.5, Math.max(0.08, wall / 5));
  const dims = (v) => ext.map((e) => Math.ceil(e / v) + 4).reduce((a, c) => a * c, 1);
  while (dims(vs) > maxVoxels) vs *= 1.1;
  const vox = voxelize(tris, vs, 2);
  const D = distanceToOutside(vox);
  const field = new Float32Array(D.length);
  let any = false;
  for (let i = 0; i < D.length; i++) {
    const v = D[i] > 0 ? (Math.sqrt(D[i]) - 0.5) * vs - wall : -wall - vs;
    field[i] = v;
    if (v > 0) any = true;
  }
  if (!any) return { cavity: new Float32Array(0), voxelSize: vs, cavityVolume: 0, modelVolume: signedVolume(tris) };
  const cavity = surfaceNets(field, vox, opts.smooth ?? 2);
  return { cavity, voxelSize: vs, cavityVolume: signedVolume(cavity), modelVolume: signedVolume(tris) };
}
