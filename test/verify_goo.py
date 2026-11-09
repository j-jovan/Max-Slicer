#!/usr/bin/env python3
"""Verify a generated .goo against a reference .goo for the same printer.
Usage: verify_goo.py generated.goo reference.goo"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from goo_parse import parse
g, gd, gvol, _ = parse(sys.argv[1], layers=True)   # asserts magic, sizes, delimiters, checksums, pixel counts, footer
r, rd, _, _ = parse(sys.argv[2])
errors = []
for k in ['Version', 'Magic', 'MachineName', 'MachineType', 'ResolutionX', 'ResolutionY', 'MirrorX', 'MirrorY', 'DisplayWidth', 'DisplayHeight', 'MachineZ',
          'DelayMode', 'BottomLightPWM', 'LightPWM', 'PerLayerSettings', 'LayerDefAddress', 'GrayScaleLevel', 'GreyLevel']:
    if g[k] != r[k]: errors.append(f'{k}: {g[k]!r} != reference {r[k]!r}')
for k in range(len(gd)):
    if abs(gd[k]['PositionZ'] - (k + 1) * g['LayerHeight']) > 1e-3: errors.append(f'layer {k} z'); break
px = g['DisplayWidth'] / g['ResolutionX'] * g['DisplayHeight'] / g['ResolutionY']
vol = gvol * px * g['LayerHeight']
if abs(vol - g['Volume']) > max(5, 0.02 * vol): errors.append(f'header volume {g["Volume"]:.1f} mm3 vs pixels {vol:.1f} mm3')
print('\n'.join('FAIL: ' + e for e in errors) or 'all fields match the reference printer; every layer decodes with valid checksum')
print('RESULT:', 'PASS' if not errors else 'FAIL'); sys.exit(1 if errors else 0)
