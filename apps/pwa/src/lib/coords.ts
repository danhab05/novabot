// Conversion coordonnées affichées (élément <img> en object-fit: contain) -> pixels de la page distante.
export interface Rect { left: number; top: number; width: number; height: number }

/** Zone réellement occupée par l'image dans l'élément (letterbox de object-fit: contain). */
export function containBox(rect: Rect, frameW: number, frameH: number): Rect {
  if (frameW <= 0 || frameH <= 0 || rect.width <= 0 || rect.height <= 0) return { ...rect, width: 0, height: 0 };
  const scale = Math.min(rect.width / frameW, rect.height / frameH);
  const w = frameW * scale, h = frameH * scale;
  return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
}

/** clientX/clientY -> coordonnées dans la page (en px de la frame). null si en dehors de l'image. */
export function mapPoint(clientX: number, clientY: number, rect: Rect, frameW: number, frameH: number): { x: number; y: number } | null {
  const box = containBox(rect, frameW, frameH);
  if (!box.width || !box.height) return null;
  const rx = clientX - box.left, ry = clientY - box.top;
  if (rx < 0 || ry < 0 || rx > box.width || ry > box.height) return null;
  return { x: Math.round((rx / box.width) * frameW), y: Math.round((ry / box.height) * frameH) };
}
