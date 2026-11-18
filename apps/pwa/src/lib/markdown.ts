// Rendu markdown léger et sûr : tout est échappé, puis on réintroduit un sous-ensemble contrôlé.
// Gère : blocs ```code```, `code`, **gras**, *italique*, ~~barré~~, liens [x](http…), URLs nues, titres #, listes - / 1., citations >, tableaux simples.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      const lang = fence[1] ? esc(fence[1]) : "code";
      html.push(`<div class="code"><div class="code-h"><span>${lang}</span><button type="button" data-copy>Copier</button></div><pre><code>${esc(buf.join("\n"))}</code></pre></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { html.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`);
      html.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      html.push(`<ol>${items.join("")}</ol>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(inline(lines[i++].replace(/^>\s?/, "")));
      html.push(`<blockquote>${buf.join("<br>")}</blockquote>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line); i += 2;
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(`<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`);
      html.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|>|\|)/.test(lines[i])) buf.push(inline(lines[i++]));
    if (!buf.length) { buf.push(inline(lines[i++])); }
    html.push(`<p>${buf.join("<br>")}</p>`);
  }
  return html.join("");
}
