// Initiale colorée stable par projet (teinte dérivée de l'id).
function hue(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function ProjectAvatar({ id, name, size = 22 }: { id: string; name: string; size?: number }) {
  const h = hue(id);
  const letter = (name.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "#").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="pav inline-flex items-center justify-center shrink-0 font-semibold"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), fontSize: Math.round(size * 0.48), ["--h" as any]: h }}
    >
      {letter}
    </span>
  );
}
