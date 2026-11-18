// Page catalogue publique (HTML sans framework) + page de confirmation d'installation par lien.
import type { CatalogItem } from "@novabot/shared";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const TYPE_LABEL: Record<string, string> = { mcp: "Connecteur", skill: "Skill", agent: "Agent" };

const BASE_CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1b1b1a;--muted:#6b6a66;--line:#e4e3df;--accent:#4f46e5;--accent-fg:#fff;--chip:#efeee9}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111113;--card:#19191c;--fg:#ececea;--muted:#9a9994;--line:#2a2a2e;--accent:#818cf8;--accent-fg:#0b0b0c;--chip:#232327}}
:root[data-theme=dark]{--bg:#111113;--card:#19191c;--fg:#ececea;--muted:#9a9994;--line:#2a2a2e;--accent:#818cf8;--accent-fg:#0b0b0c;--chip:#232327}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}header h1{margin:0 0 4px;font-size:24px}header p{margin:0;color:var(--muted)}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.bar input{flex:1 1 220px;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit}
.bar button{padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer}.bar button[aria-pressed=true]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px}
.card h2{margin:0;font-size:16px}.card p{margin:0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.chip{align-self:flex-start;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--muted)}
.row{display:flex;gap:8px;margin-top:auto;flex-wrap:wrap}.btn{display:inline-block;padding:8px 12px;border-radius:10px;text-decoration:none;font-size:14px;border:1px solid var(--line);color:var(--fg);background:transparent;cursor:pointer;font-family:inherit}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.empty{color:var(--muted);padding:40px 0;text-align:center}
dialog{max-width:min(640px,calc(100vw - 32px));border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--fg);padding:20px}dialog::backdrop{background:#0007}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:13px;max-height:50vh;overflow:auto}
label{display:block;margin:8px 0 4px;font-size:14px}`;

export function renderCatalogPage(items: CatalogItem[], publicUrl: string) {
  const data = items.map((i) => ({ id: i.manifest.id, type: i.manifest.type, name: i.manifest.name, description: i.manifest.description, version: i.manifest.version, author: i.manifest.author ?? "", permissions: i.manifest.permissions ?? [], secrets: (i.manifest.secrets ?? []).map((s) => s.label) }));
  const base = publicUrl.replace(/\/$/, "");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Catalogue Novabot</title><meta name="description" content="Agents, skills et connecteurs publiés pour Novabot.">
<style>${BASE_CSS}</style></head><body><div class="wrap">
<header><h1>Catalogue Novabot</h1><p>Agents, skills et connecteurs à installer dans ton Novabot en un clic.</p></header>
<div class="bar" role="toolbar"><input id="q" type="search" placeholder="Rechercher…" aria-label="Rechercher">
<button data-t="" aria-pressed="true">Tout</button><button data-t="agent" aria-pressed="false">Agents</button><button data-t="skill" aria-pressed="false">Skills</button><button data-t="mcp" aria-pressed="false">Connecteurs</button></div>
<div id="grid" class="grid"></div><div id="empty" class="empty" hidden>Rien de publié pour l'instant.</div>
<dialog id="dlg"><h2 id="dt"></h2><p id="dd"></p><div id="dm"></div>
<label for="nb">Adresse de ton Novabot</label><input id="nb" type="url" placeholder="https://mon-novabot.exemple.fr" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font:inherit">
<div class="row" style="margin-top:12px"><a id="go" class="btn primary" href="#">Installer dans mon Novabot</a><a id="js" class="btn" href="#">Manifeste JSON</a><button class="btn" onclick="dlg.close()">Fermer</button></div></dialog>
</div><script>
const ITEMS=${JSON.stringify(data).replace(/</g, "\\u003c")};const BASE=${JSON.stringify(base)};
const L=${JSON.stringify(TYPE_LABEL)};let t="";const q=document.getElementById("q"),grid=document.getElementById("grid"),empty=document.getElementById("empty");
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function draw(){const s=q.value.toLowerCase();const list=ITEMS.filter(i=>(!t||i.type===t)&&(!s||(i.name+" "+i.description).toLowerCase().includes(s)));
grid.innerHTML=list.map(i=>'<article class="card"><span class="chip">'+L[i.type]+'</span><h2>'+e(i.name)+'</h2><p>'+e(i.description)+'</p><div class="row"><button class="btn primary" data-id="'+e(i.id)+'">Voir et installer</button></div></article>').join("");empty.hidden=list.length>0;}
document.querySelectorAll(".bar button").forEach(b=>b.onclick=()=>{t=b.dataset.t;document.querySelectorAll(".bar button").forEach(x=>x.setAttribute("aria-pressed",x===b));draw();});
q.oninput=draw;const nb=document.getElementById("nb");try{nb.value=localStorage.getItem("novabot.url")||""}catch{}
grid.onclick=ev=>{const id=ev.target.closest("[data-id]")?.dataset.id;if(!id)return;const i=ITEMS.find(x=>x.id===id);
document.getElementById("dt").textContent=i.name;document.getElementById("dd").textContent=i.description;
document.getElementById("dm").innerHTML='<p class="chip">'+L[i.type]+' · v'+e(i.version)+(i.author?' · '+e(i.author):'')+'</p>'+(i.permissions.length?'<p><b>Accès :</b> '+i.permissions.map(e).join(", ")+'</p>':'')+(i.secrets.length?'<p><b>Secrets demandés :</b> '+i.secrets.map(e).join(", ")+'</p>':'');
const src=BASE+"/pub/catalogue/"+encodeURIComponent(id)+".json";document.getElementById("js").href=src;
const go=document.getElementById("go");const upd=()=>{const u=nb.value.trim().replace(/\\/$/,"");go.href=u?u+"/catalog/install?src="+encodeURIComponent(src):"#";try{localStorage.setItem("novabot.url",u)}catch{}};nb.oninput=upd;upd();dlg.showModal();};
draw();</script></body></html>`;
}

export function renderInstallPage(src: string, loggedIn: boolean) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Installer dans Novabot</title><style>${BASE_CSS}</style></head><body><div class="wrap" style="max-width:640px">
<header><h1>Installer dans Novabot</h1><p>Source : <code>${esc(src)}</code></p></header>
${loggedIn ? `<div class="card" style="margin-top:20px"><p>Novabot va télécharger ce manifeste, le valider, puis l'ajouter à ton catalogue. Rien n'est exécuté avant que tu cliques « Installer » dans le catalogue.</p>
<div class="row"><button id="imp" class="btn primary">Ajouter au catalogue</button><a class="btn" href="/">Annuler</a></div><pre id="out" hidden></pre></div>
<script>document.getElementById("imp").onclick=async()=>{const o=document.getElementById("out");o.hidden=false;o.textContent="Import…";
const r=await fetch("/api/catalog/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:${JSON.stringify(src).replace(/</g, "\\u003c")}})});
const j=await r.json();o.textContent=r.ok?"Ajouté : "+j.manifest.name+" ("+j.manifest.type+"). Ouvre le catalogue de Novabot pour l'installer.":"Erreur : "+(j.error||r.status);};</script>`
    : `<div class="card" style="margin-top:20px"><p>Connecte-toi d'abord à ton Novabot, puis rouvre ce lien.</p><div class="row"><a class="btn primary" href="/auth/discord">Se connecter</a></div></div>`}
</div></body></html>`;
}
