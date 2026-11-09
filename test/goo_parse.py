#!/usr/bin/env python3
"""Independent Elegoo GOO V3 parser/decoder (used to verify our writer).
Usage: goo_parse.py file.goo [--layers]   prints header; --layers decodes every layer."""
import struct, sys, json

HDR = [  # (name, fmt or byte count)
 ('Version','4s'),('Magic','8s'),('SoftwareName','32s'),('SoftwareVersion','24s'),('FileCreateTime','24s'),
 ('MachineName','32s'),('MachineType','32s'),('ProfileName','32s'),('AntiAliasingLevel','>H'),('GreyLevel','>H'),('BlurLevel','>H'),
 ('SmallPreview',116*116*2),('Delim1','2s'),('BigPreview',290*290*2),('Delim2','2s'),
 ('LayerCount','>I'),('ResolutionX','>H'),('ResolutionY','>H'),('MirrorX','>B'),('MirrorY','>B'),
 ('DisplayWidth','>f'),('DisplayHeight','>f'),('MachineZ','>f'),('LayerHeight','>f'),('ExposureTime','>f'),('DelayMode','>B'),
 ('LightOffDelay','>f'),('BottomWaitTimeAfterCure','>f'),('BottomWaitTimeAfterLift','>f'),('BottomWaitTimeBeforeCure','>f'),
 ('WaitTimeAfterCure','>f'),('WaitTimeAfterLift','>f'),('WaitTimeBeforeCure','>f'),('BottomExposureTime','>f'),('BottomLayerCount','>I'),
 ('BottomLiftHeight','>f'),('BottomLiftSpeed','>f'),('LiftHeight','>f'),('LiftSpeed','>f'),('BottomRetractHeight','>f'),('BottomRetractSpeed','>f'),
 ('RetractHeight','>f'),('RetractSpeed','>f'),('BottomLiftHeight2','>f'),('BottomLiftSpeed2','>f'),('LiftHeight2','>f'),('LiftSpeed2','>f'),
 ('BottomRetractHeight2','>f'),('BottomRetractSpeed2','>f'),('RetractHeight2','>f'),('RetractSpeed2','>f'),('BottomLightPWM','>H'),('LightPWM','>H'),
 ('PerLayerSettings','>B'),('PrintTime','>I'),('Volume','>f'),('MaterialGrams','>f'),('MaterialCost','>f'),('PriceCurrencySymbol','8s'),
 ('LayerDefAddress','>I'),('GrayScaleLevel','>B'),('TransitionLayerCount','>H'),
]
LDEF = [('Pause','>H'),('PausePositionZ','>f'),('PositionZ','>f'),('ExposureTime','>f'),('LightOffDelay','>f'),('WaitTimeAfterCure','>f'),
 ('WaitTimeAfterLift','>f'),('WaitTimeBeforeCure','>f'),('LiftHeight','>f'),('LiftSpeed','>f'),('LiftHeight2','>f'),('LiftSpeed2','>f'),
 ('RetractHeight','>f'),('RetractSpeed','>f'),('RetractHeight2','>f'),('RetractSpeed2','>f'),('LightPWM','>H'),('Delim','2s'),('DataLength','>I')]

def read(d, o, spec):
    out = {}
    for name, f in spec:
        if isinstance(f, int): out[name] = d[o:o+f]; o += f
        else:
            v = struct.unpack_from(f, d, o)[0]; o += struct.calcsize(f)
            out[name] = v.rstrip(b'\0').decode('latin1') if isinstance(v, bytes) and name not in ('Magic','Delim1','Delim2','Delim') else v
    return out, o

def decode(rle, npix):
    """Returns (pixel count, sum of grey/255, histogram of values) and checks magic + checksum."""
    assert rle[0] == 0x55, 'layer magic'
    cs = (~(sum(rle[1:-1]) & 0xff)) & 0xff
    assert rle[-1] == cs, f'checksum {rle[-1]} != {cs}'
    i, n, last, color, pix, on, hist = 1, len(rle) - 1, len(rle) - 1, 0, 0, 0.0, {}
    while i < last:
        b = rle[i]; t = b >> 6
        if t == 2:
            dt, dv = (b >> 4) & 3, b & 15
            if dt in (0, 1): color += dv
            else: color -= dv
            stride = rle[i + 1] if dt in (1, 3) else 1
            if dt in (1, 3): i += 1
        else:
            if t == 0: color = 0
            elif t == 3: color = 255
            j = i
            if t == 1: i += 1; color = rle[i]
            L = (b >> 4) & 3
            stride = b & 15
            ext = rle[i + 1:i + 1 + L]
            for k, e in enumerate(ext): stride += e << (4 + 8 * (L - 1 - k))
            i += L
        i += 1
        pix += stride; on += stride * color / 255; hist[color] = hist.get(color, 0) + stride
    assert pix == npix, f'pixels {pix} != {npix}'
    return pix, on, hist

def parse(path, layers=False):
    d = open(path, 'rb').read()
    h, o = read(d, 0, HDR)
    assert h['Version'] == 'V3.0' and h['Magic'] == b'\x07\0\0\0DLP\0', 'magic'
    assert o == h['LayerDefAddress'], f'header size {o} != LayerDefAddress {h["LayerDefAddress"]}'
    defs, vol = [], 0.0
    npix = h['ResolutionX'] * h['ResolutionY']
    for k in range(h['LayerCount']):
        ld, o = read(d, o, LDEF)
        rle = d[o:o + ld['DataLength']]; o += ld['DataLength']
        assert d[o:o + 2] == b'\r\n', f'layer {k} trailing delimiter'; o += 2
        assert ld['Delim'] == b'\r\n'
        if layers:
            _, on, _ = decode(rle, npix); vol += on
        defs.append(ld)
    footer = d[o:]
    assert footer == b'\0\0\0\x07\0\0\0DLP\0', f'footer {footer!r}'
    return h, defs, vol, d

if __name__ == '__main__':
    h, defs, vol, d = parse(sys.argv[1], '--layers' in sys.argv)
    show = {k: (v if not isinstance(v, bytes) else v.hex() if len(v) < 16 else f'<{len(v)} bytes>') for k, v in h.items()}
    print(json.dumps(show, indent=1))
    for k in [0, 1, len(defs) // 2, len(defs) - 1]:
        print('layer', k, {a: round(b, 4) if isinstance(b, float) else b for a, b in defs[k].items() if a != 'Delim'})
    if '--layers' in sys.argv:
        px = h['DisplayWidth'] / h['ResolutionX'] * h['DisplayHeight'] / h['ResolutionY']
        print('all layers decoded, checksums OK; volume from pixels:', round(vol * px * h['LayerHeight'] / 1000, 2), 'ml')
