// 3D workspace (three.js, Z-up, millimetres).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { M7MAX } from '../core/printer.js';

export const COLORS = {
  bg: 0x1b1f26, plate: 0x262c35, grid: 0x343c48, gridMajor: 0x45505f, area: 0x6b7686,
  model: 0xaab3bf, modelSel: 0xf0a23b, support: 0x8e7cff, supportHover: 0xff6b6b, raft: 0x7a6ae0,
  cavity: 0x4fb3c8, hole: 0xe5534b, island: 0xe5534b, suction: 0xf0a23b, trapped: 0x4fb3c8,
};

export class Viewer {
  constructor(container) {
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(COLORS.bg);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, -330, 230);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 30);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

    this.scene.add(new THREE.HemisphereLight(0xe8eef6, 0x30363f, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-120, -200, 300);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb8c4ff, 0.6);
    rim.position.set(200, 220, 120);
    this.scene.add(rim);

    this.buildPlate();
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
    this.clipEnabled = false;

    this.modelRoot = new THREE.Group(); this.scene.add(this.modelRoot);
    this.supportRoot = new THREE.Group(); this.scene.add(this.supportRoot);
    this.markerRoot = new THREE.Group(); this.scene.add(this.markerRoot);
    this.objects = new Map(); // model id -> {group, mesh, cavity, holes, supports}

    this.matModel = new THREE.MeshStandardMaterial({ color: COLORS.model, roughness: 0.55, metalness: 0.05, clippingPlanes: [this.clipPlane], side: THREE.DoubleSide });
    this.matModelSel = new THREE.MeshStandardMaterial({ color: COLORS.model, emissive: COLORS.modelSel, emissiveIntensity: 0.22, roughness: 0.5, metalness: 0.05, clippingPlanes: [this.clipPlane], side: THREE.DoubleSide });
    this.matModelXray = new THREE.MeshStandardMaterial({ color: COLORS.model, transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.6, clippingPlanes: [this.clipPlane], side: THREE.DoubleSide });
    this.matSupport = new THREE.MeshStandardMaterial({ color: COLORS.support, roughness: 0.45, metalness: 0.0, clippingPlanes: [this.clipPlane] });
    this.matCavity = new THREE.MeshStandardMaterial({ color: COLORS.cavity, roughness: 0.6, transparent: true, opacity: 0.55, clippingPlanes: [this.clipPlane], side: THREE.DoubleSide });
    this.matHole = new THREE.MeshStandardMaterial({ color: COLORS.hole, roughness: 0.5, clippingPlanes: [this.clipPlane] });
    this.xray = false;

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.8);
    this.transform.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; this.onDragging?.(e.value); });
    this.transform.addEventListener('objectChange', () => this.onTransformChange?.());
    this.scene.add(this.transform.getHelper());

    this.raycaster = new THREE.Raycaster();
    this.hoverSupport = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.dirty = true;
    this.controls.addEventListener('change', () => (this.dirty = true));
    const loop = () => {
      requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (this.dirty || moved) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    };
    loop();
  }

  buildPlate() {
    const W = M7MAX.displayW, H = M7MAX.displayH;
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ color: COLORS.plate, roughness: 0.9 }));
    plate.position.z = -0.05;
    g.add(plate);
    const pts = [], major = [];
    for (let x = -Math.floor(W / 2 / 10) * 10; x <= W / 2; x += 10) (x % 50 === 0 ? major : pts).push(x, -H / 2, 0, x, H / 2, 0);
    for (let y = -Math.floor(H / 2 / 10) * 10; y <= H / 2; y += 10) (y % 50 === 0 ? major : pts).push(-W / 2, y, 0, W / 2, y, 0);
    const lg = (arr, color) => { const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); return new THREE.LineSegments(b, new THREE.LineBasicMaterial({ color })); };
    g.add(lg(pts, COLORS.grid), lg(major, COLORS.gridMajor));
    const w = M7MAX.printW / 2, h = M7MAX.printH / 2, Z = M7MAX.maxZ;
    const box = [];
    const c = [[-w, -h], [w, -h], [w, h], [-w, h]];
    for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; box.push(a[0], a[1], 0.02, b[0], b[1], 0.02, a[0], a[1], Z, b[0], b[1], Z, a[0], a[1], 0.02, a[0], a[1], Z); }
    const area = lg(box, COLORS.area);
    area.material.transparent = true; area.material.opacity = 0.55;
    g.add(area);
    // front marker
    const tri = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-6, -H / 2 - 4, 0), new THREE.Vector3(6, -H / 2 - 4, 0), new THREE.Vector3(0, -H / 2 - 12, 0)]), new THREE.MeshBasicMaterial({ color: COLORS.modelSel, side: THREE.DoubleSide }));
    g.add(tri);
    this.scene.add(g);
    this.plateGroup = g;
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // ------------------------------------------------------------ models
  geometryFrom(tris) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.computeVertexNormals();
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }

  addModel(m) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(this.geometryFrom(m.tris), this.matModel);
    mesh.userData.modelId = m.id;
    group.add(mesh);
    group.userData.modelId = m.id;
    const holder = new THREE.Group(); // rotation+translation only (for cavity & holes, which live in scaled-local frame)
    this.modelRoot.add(group);
    this.modelRoot.add(holder);
    const supports = new THREE.Mesh(new THREE.BufferGeometry(), this.matSupport);
    supports.userData.supportOf = m.id;
    this.supportRoot.add(supports);
    this.objects.set(m.id, { group, mesh, holder, cavity: null, holes: new THREE.Group(), supports });
    holder.add(this.objects.get(m.id).holes);
    this.syncModel(m);
  }

  removeModel(id) {
    const o = this.objects.get(id);
    if (!o) return;
    if (this.transform.object === o.group) this.transform.detach();
    this.modelRoot.remove(o.group, o.holder);
    this.supportRoot.remove(o.supports);
    o.mesh.geometry.dispose(); o.supports.geometry.dispose(); o.cavity?.geometry.dispose();
    this.objects.delete(id);
    this.dirty = true;
  }

  syncModel(m, selected = false) {
    const o = this.objects.get(m.id);
    if (!o) return;
    o.group.position.fromArray(m.position);
    o.group.quaternion.fromArray(m.quaternion);
    o.group.scale.fromArray(m.scale);
    o.holder.position.fromArray(m.position);
    o.holder.quaternion.fromArray(m.quaternion);
    o.group.visible = o.holder.visible = o.supports.visible = m.visible !== false;
    o.mesh.material = this.xray ? this.matModelXray : selected ? this.matModelSel : this.matModel;
    // cavity
    if (m.cavity && m.hollow?.enabled) {
      if (!o.cavity || o.cavity.userData.src !== m.cavity) {
        if (o.cavity) { o.holder.remove(o.cavity); o.cavity.geometry.dispose(); }
        o.cavity = new THREE.Mesh(this.geometryFrom(m.cavity), this.matCavity);
        o.cavity.userData.src = m.cavity;
        o.holder.add(o.cavity);
      }
      o.cavity.visible = this.xray;
    } else if (o.cavity) { o.holder.remove(o.cavity); o.cavity.geometry.dispose(); o.cavity = null; }
    // holes
    o.holes.clear();
    for (const h of m.holes || []) {
      const len = h.depth;
      const geo = new THREE.CylinderGeometry(h.diameter / 2, h.diameter / 2, len, 20);
      geo.rotateX(Math.PI / 2); // cylinder along Z
      const mesh = new THREE.Mesh(geo, this.matHole);
      const dir = new THREE.Vector3().fromArray(h.dir);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      mesh.position.fromArray(h.p).addScaledVector(dir, len / 2 - 1);
      mesh.userData.holeOf = m.id;
      o.holes.add(mesh);
    }
    this.dirty = true;
  }

  setSupports(id, tris) {
    const o = this.objects.get(id);
    if (!o) return;
    o.supports.geometry.dispose();
    o.supports.geometry = tris && tris.length ? this.geometryFrom(tris) : new THREE.BufferGeometry();
    this.dirty = true;
  }

  setXray(on, models) {
    this.xray = on;
    for (const m of models) this.syncModel(m, m.__selected);
  }

  select(id) {
    const o = id != null ? this.objects.get(id) : null;
    if (o && this.transformMode) this.transform.attach(o.group); else this.transform.detach();
    this.dirty = true;
  }

  setTransformMode(mode) {
    this.transformMode = mode;
    if (mode) this.transform.setMode(mode);
    this.transform.setSpace(mode === 'rotate' ? 'world' : 'world');
    this.dirty = true;
  }

  // ------------------------------------------------------------ picking
  pick(ev, what = 'model') {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [];
    if (what === 'model' || what === 'any') for (const o of this.objects.values()) if (o.group.visible) targets.push(o.mesh);
    if (what === 'support' || what === 'any') for (const o of this.objects.values()) if (o.supports.visible) targets.push(o.supports);
    const hits = this.raycaster.intersectObjects(targets, false).filter((h) => !this.clipEnabled || h.point.z <= this.clipZ + 1e-3);
    if (!hits.length) return null;
    const h = hits[0];
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
    return { point: h.point.clone(), normal: n, object: h.object, faceIndex: h.faceIndex, modelId: h.object.userData.modelId ?? h.object.userData.supportOf, isSupport: h.object.userData.supportOf != null };
  }

  // ------------------------------------------------------------ markers / clipping
  setMarkers(list) {
    this.markerRoot.clear();
    for (const mk of list) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(mk.r || 1.2, 16, 12), new THREE.MeshBasicMaterial({ color: mk.color, transparent: true, opacity: 0.85, depthTest: false }));
      s.renderOrder = 10;
      s.position.set(mk.x, mk.y, mk.z);
      this.markerRoot.add(s);
    }
    this.dirty = true;
  }

  setClip(z) {
    this.clipEnabled = z != null;
    this.clipZ = z ?? 1e6;
    this.clipPlane.constant = this.clipEnabled ? z : 1e6;
    this.dirty = true;
  }

  focus(box) {
    const c = new THREE.Vector3(), s = new THREE.Vector3();
    box.getCenter(c); box.getSize(s);
    const r = Math.max(30, s.length() * 0.6);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, r / Math.sin((this.camera.fov * Math.PI) / 360));
    this.dirty = true;
  }

  view(name) {
    const t = this.controls.target, d = this.camera.position.distanceTo(t);
    const dirs = { iso: [0, -0.82, 0.57], top: [0, -0.001, 1], front: [0, -1, 0.05], right: [1, 0, 0.05], left: [-1, 0, 0.05], back: [0, 1, 0.05], bottom: [0, -0.001, -1] };
    const v = new THREE.Vector3(...dirs[name]).normalize();
    this.camera.position.copy(t).addScaledVector(v, d);
    this.dirty = true;
  }

  // Render a PNG preview (for the print file) from an iso camera framing everything.
  async renderPreview(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    r.setClearColor(0x05486a, 1);
    const box = new THREE.Box3();
    for (const o of this.objects.values()) if (o.group.visible) { box.expandByObject(o.group); if (o.supports.geometry.attributes.position) box.expandByObject(o.supports); }
    const cam = new THREE.PerspectiveCamera(30, w / h, 1, 5000);
    cam.up.set(0, 0, 1);
    const c = new THREE.Vector3(), s = new THREE.Vector3();
    box.getCenter(c); box.getSize(s);
    const rad = Math.max(10, s.length() / 2);
    cam.position.copy(c).add(new THREE.Vector3(0.55, -0.75, 0.55).normalize().multiplyScalar(rad / Math.sin((15 * Math.PI) / 180)));
    cam.lookAt(c);
    const hidden = [this.plateGroup, this.markerRoot, this.transform.getHelper()];
    const prevVis = hidden.map((x) => x.visible);
    hidden.forEach((x) => (x.visible = false));
    const clip = this.clipPlane.constant;
    this.clipPlane.constant = 1e6;
    const prevBg = this.scene.background;
    r.render(this.scene, cam);
    hidden.forEach((x, i) => (x.visible = prevVis[i]));
    this.clipPlane.constant = clip;
    this.scene.background = prevBg;
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    r.dispose();
    return new Uint8Array(await blob.arrayBuffer());
  }
}
