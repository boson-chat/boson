import { describe, it, expect } from 'vitest';
import { formatHex, hsvToHex, hsvToRgb, parseColor, parseHex, rgbToHsv } from './color';

describe('theme picker colour maths', () => {
  it('parses every hex form, alpha included', () => {
    expect(parseHex('#D97706')).toEqual({ r: 217, g: 119, b: 6, a: 1 });
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#0008')).toEqual({ r: 0, g: 0, b: 0, a: 0x88 / 255 });
    expect(parseHex('#11223380')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 0x80 / 255 });
    expect(parseHex('  #abcdef ')).not.toBeNull();
    for (const bad of ['', 'D97706', '#12', '#12345', '#ggg', 'red']) expect(parseHex(bad)).toBeNull();
  });

  it('writes #rrggbb when opaque, #rrggbbaa otherwise', () => {
    expect(formatHex({ r: 217, g: 119, b: 6, a: 1 })).toBe('#d97706');
    expect(formatHex({ r: 217, g: 119, b: 6, a: 0.5 })).toBe('#d9770680');
    expect(formatHex({ r: 300, g: -5, b: 12.6, a: 1 })).toBe('#ff000d');
  });

  it('round-trips through HSV', () => {
    for (const hex of ['#d97706', '#88c0d0', '#000000', '#ffffff', '#808080', '#39ff6a', '#ef444480']) {
      expect(formatHex(hsvToRgb(rgbToHsv(parseHex(hex)!)))).toBe(hex);
    }
  });

  it('knows the primaries in HSV', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 1 }).h).toBe(120);
    expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 1 }).h).toBe(240);
    expect(hsvToHex({ h: 60, s: 1, v: 1, a: 1 })).toBe('#ffff00');
    expect(hsvToHex({ h: 360, s: 1, v: 1, a: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: 200, s: 0, v: 0.5, a: 1 })).toBe('#808080');
  });

  it('parseColor takes hex without a canvas, and rejects what it can\'t read', () => {
    expect(parseColor('#88C0D0')).toEqual({ r: 0x88, g: 0xc0, b: 0xd0, a: 1 });
    expect(parseColor('not a colour')).toBeNull();
  });
});
