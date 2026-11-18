/** Découpe un texte en morceaux ≤ max (2000 pour Discord), en coupant de préférence sur ligne / espace,
 *  et en refermant/rouvrant les blocs de code ``` coupés. */
export function chunkMessage(text: string, max = 2000): string[] {
  const out: string[] = [];
  let rest = text ?? "";
  let openFence: string | null = null; // langage du bloc ``` resté ouvert au morceau précédent
  while (rest.length) {
    const prefix = openFence !== null ? "```" + openFence + "\n" : "";
    const budget = max - prefix.length - 4; // place pour refermer "\n```"
    if (prefix.length + rest.length <= max) { out.push(prefix + rest); break; }
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf(" ", budget);
    if (cut < budget * 0.5) cut = budget;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^[\n ]/, "");
    // état des fences dans (prefix + piece)
    let fence: string | null = openFence;
    for (const m of piece.matchAll(/```(\w*)/g)) fence = fence === null ? m[1] : null;
    let body = prefix + piece;
    if (fence !== null) body += "\n```";
    out.push(body);
    openFence = fence;
  }
  return out.filter((s) => s.trim().length);
}
