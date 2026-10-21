import { describe, expect, it } from 'vitest';
import { isTrayAtMenuBar } from '../electron/trayVisibility.js';

const displays = [
  {
    bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    workArea: { x: 0, y: 33, width: 1728, height: 1045 },
  },
  {
    bounds: { x: 1728, y: -344, width: 3008, height: 1692 },
    workArea: { x: 1728, y: -314, width: 3008, height: 1662 },
  },
];

describe('menu bar tray geometry', () => {
  it('rejects the detached production proxy and initial zero-sized sample', () => {
    expect(isTrayAtMenuBar({ x: 0, y: 1117, width: 62, height: 22 }, displays)).toBe(false);
    expect(isTrayAtMenuBar({ x: 0, y: 0, width: 62, height: 0 }, displays)).toBe(false);
    expect(isTrayAtMenuBar({ x: 0, y: 0, width: 0, height: 22 }, displays)).toBe(false);
  });

  it('accepts the observed hosted item on a display with a negative origin', () => {
    expect(isTrayAtMenuBar({ x: 4228, y: -344, width: 62, height: 30 }, displays)).toBe(true);
    expect(isTrayAtMenuBar({ x: 1600, y: 0, width: 62, height: 22 }, displays)).toBe(true);
  });

  it('requires the entire item to lie within one display menu region', () => {
    for (const bounds of [
      { x: -1, y: 0, width: 62, height: 22 },
      { x: 1700, y: 0, width: 62, height: 22 },
      { x: 0, y: -1, width: 62, height: 22 },
      { x: 0, y: 32, width: 62, height: 22 },
      { x: 4226, y: -313, width: 62, height: 22 },
    ])
      expect(isTrayAtMenuBar(bounds, displays)).toBe(false);
  });

  it('supports a menu overlay while rejecting invalid rectangles and absent displays', () => {
    const overlay = [{ bounds: displays[0].bounds, workArea: displays[0].bounds }];
    expect(isTrayAtMenuBar({ x: 10, y: 0, width: 62, height: 24 }, overlay)).toBe(true);
    expect(isTrayAtMenuBar({ x: 10, y: 0, width: 62, height: 25 }, overlay)).toBe(false);
    expect(isTrayAtMenuBar({ x: NaN, y: 0, width: 62, height: 22 }, displays)).toBe(false);
    expect(isTrayAtMenuBar({ x: 0, y: 0, width: -1, height: 22 }, displays)).toBe(false);
    expect(isTrayAtMenuBar({ x: 0, y: 0, width: 62, height: 22 }, [])).toBe(false);
  });
});
