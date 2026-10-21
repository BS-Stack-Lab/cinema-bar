import type { Rectangle } from 'electron';

interface TrayDisplay {
  bounds: Rectangle;
  workArea: Rectangle;
}

export interface TraySample {
  at: number;
  bounds: Rectangle;
  intersectsMenuBar: boolean;
  displays: (TrayDisplay & { id: number; scaleFactor: number })[];
}

export function isTrayAtMenuBar(bounds: Rectangle, displays: TrayDisplay[]) {
  if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0)
    return false;
  return displays.some((display) => {
    const menuHeight = Math.min(
      display.bounds.height,
      Math.max(24, display.workArea.y - display.bounds.y),
    );
    return (
      bounds.x >= display.bounds.x &&
      bounds.x + bounds.width <= display.bounds.x + display.bounds.width &&
      bounds.y >= display.bounds.y &&
      bounds.y + bounds.height <= display.bounds.y + menuHeight
    );
  });
}
