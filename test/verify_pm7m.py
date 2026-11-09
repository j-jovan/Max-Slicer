#!/usr/bin/env python3
"""Independent structural verification of a generated .pm7m against a reference
.pm7m produced by Lychee Slicer for the Anycubic Photon Mono M7 Max.

Usage: verify_pm7m.py generated.pm7m reference.pm7m
Exits non-zero on any structural difference that could matter to the printer."""
import json, struct, sys, zipfile, re

W, H = 6480, 3600
errors = []

def err(msg):
    errors.append(msg)
    print('  FAIL:', msg)

def keyshape(o):
    if isinstance(o, dict):
        return {k: keyshape(v) for k, v in o.items()}
    if isinstance(o, list):
        return [keyshape(o[0])] if o else []
    if isinstance(o, bool):
        return 'bool'
    if isinstance(o, (int, float)):
        return 'num'
    return type(o).__name__

def compare_shape(a, b, path=''):
    if isinstance(b, dict):
        if not isinstance(a, dict):
            return err(f'{path}: expected object')
        for k in b:
            if k not in a:
                err(f'{path}/{k}: missing key')
            else:
                compare_shape(a[k], b[k], f'{path}/{k}')
        for k in a:
            if k not in b:
                err(f'{path}/{k}: extra key not in reference')
        if list(a.keys()) != [k for k in b.keys() if k in a]:
            err(f'{path}: key order differs from reference')
    elif isinstance(b, list):
        if not isinstance(a, list):
            return err(f'{path}: expected array')
        if b and a:
            compare_shape(a[0], b[0], path + '[0]')
    else:
        if a != b:
            err(f'{path}: type {a} != reference {b}')

def decode_pw0(d):
    i = 0; tot = 0; on = 0; n = len(d)
    while i < n:
        b = d[i]; c = b >> 4
        if c in (0, 15):
            if i + 1 >= n:
                raise ValueError('truncated 2-byte run')
            r = ((b & 15) << 8) | d[i + 1]; i += 2
        else:
            r = b & 15; i += 1
        if r == 0:
            raise ValueError('zero-length run')
        tot += r; on += r * c / 15
    return tot, on

def main(gen, ref):
    g = zipfile.ZipFile(gen); r = zipfile.ZipFile(ref)
    print('ZIP integrity'); bad = g.testzip()
    if bad: err(f'corrupt entry {bad}')
    gn = [i.filename for i in g.infolist()]; rn = [i.filename for i in r.infolist()]
    norm = lambda names: [re.sub(r'layer_\d+\.', 'layer_N.', n) for n in names]
    print('Entry set / order')
    gs = sorted(set(norm(gn))); rs = sorted(set(norm(rn)))
    if gs != rs: err(f'entry set differs: {gs} vs {rs}')
    if gn != sorted(gn, key=lambda s: s.upper()): err('entry order is not the reference ordering')
    for i in g.infolist():
        if i.compress_type not in (0, 8): err(f'{i.filename}: compression {i.compress_type}')
        if i.flag_bits & 1: err(f'{i.filename}: encrypted')

    print('JSON documents (shape and key order vs reference)')
    for name in ['anycubic_photon_resins.pwsp', 'layers_controller.conf', 'print_info.json', 'software_info.conf']:
        graw = g.read(name); rraw = r.read(name)
        if (b'\r\n' in graw) != (b'\r\n' in rraw): err(f'{name}: line endings differ')
        gj = json.loads(graw); rj = json.loads(rraw)
        if name == 'layers_controller.conf':
            compare_shape(keyshape(gj["paras"][0]), keyshape(rj["paras"][0]), name + "/paras[0]")
            if gj['count'] != len(gj['paras']): err('layers_controller count mismatch')
            for k, p in enumerate(gj['paras']):
                if p['layer_index'] != k: err(f'layer_index {k}'); break
        elif name == 'anycubic_photon_resins.pwsp':
            # user resin may carry our values but must keep the reference shape
            compare_shape(keyshape(gj), keyshape(rj), name)
            mt = gj['machine_type']
            for key in ['res_x', 'res_y', 'xy_pixel', 'print_xsize', 'print_ysize', 'print_zsize', 'name', 'key_suffix', 'property']:
                if mt[key] != rj['machine_type'][key]: err(f'machine_type.{key} differs: {mt[key]} vs {rj["machine_type"][key]}')
            act = gj['machine_extern']['active_resins'][0]
            if act not in [u['property']['name'] for u in gj['machine_extern']['user_resins']]:
                err('active resin not found in user_resins')
        else:
            compare_shape(keyshape(gj), keyshape(rj), name)

    print('scene.slice binary layout')
    s = g.read('scene.slice'); rs_ = r.read('scene.slice')
    if s[:13] != b'ANYCUBIC-PWSZ': err('magic')
    for off, fmt in [(80, '<I'), (84, '<I'), (88, '<I'), (92, '<I'), (96, '<f')]:
        if struct.unpack_from(fmt, s, off) != struct.unpack_from(fmt, rs_, off): err(f'scene header field @{off} differs from reference')
    n = struct.unpack_from('<I', s, 100)[0]
    if s[388:392] != b'<---': err('separator')
    if struct.unpack_from('<I', s, 392)[0] != n: err('layer def count')
    if len(s) != 400 + 64 * n: err(f'scene size {len(s)} != {400 + 64 * n}')
    if s[-4:] != b'--->': err('end marker')
    lc = json.loads(g.read('layers_controller.conf'))
    if n != lc['count']: err('scene layer count != layers_controller count')
    for k in range(n):
        z = struct.unpack_from('<f', s, 396 + 64 * k)[0]
        exp = lc['paras'][k]['layer_minheight'] + lc['paras'][k]['layer_thickness']
        if abs(z - exp) > 1e-4: err(f'scene z of layer {k}: {z} vs {exp}'); break

    print('Layer images')
    layer_names = [x for x in gn if x.startswith('layer_images/')]
    if len(layer_names) != n: err(f'{len(layer_names)} layer files for {n} layers')
    vol = 0.0
    for k in range(n):
        d = g.read(f'layer_images/layer_{k}.pw0Img')
        tot, on = decode_pw0(d)
        if tot != W * H: err(f'layer {k}: {tot} pixels'); break
        vol += on
    vol_ml = vol * 0.046 * 0.046 * lc['paras'][0]['layer_thickness'] / 1000
    pi = json.loads(g.read('print_info.json'))
    print(f'  decoded volume {vol_ml:.2f} ml, print_info says {pi["volume"]} ml')
    if abs(vol_ml - pi['volume']) > max(1.0, 0.02 * vol_ml): err('print_info volume disagrees with layer data')

    print('Previews')
    from PIL import Image
    import io
    for i, size in enumerate([(224, 168), (336, 252)]):
        im = Image.open(io.BytesIO(g.read(f'preview_images/preview_{i}.png')))
        if im.size != size: err(f'preview {i} size {im.size}')
    print('RESULT:', 'PASS' if not errors else f'{len(errors)} problem(s)')
    sys.exit(1 if errors else 0)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
