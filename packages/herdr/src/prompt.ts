// Prompts envoyés aux agents (modèle du skill chef-orchestre).
import type { Project, Task } from "@novabot/shared";

/** Prénom du propriétaire (NOVABOT_OWNER_NAME, chargé depuis secrets.env par la config du daemon). */
const owner = () => process.env.NOVABOT_OWNER_NAME || "Owner";
const lang = () => process.env.NOVABOT_LANGUAGE || "français";

export function taskPrompt(o: { task: Task; project: Project | null; cwd: string; branch: string | null; context: string | null }): string {
  const { task, project, cwd, branch } = o;
  const autonomy = project?.autonomy ?? "full";
  const auto =
    autonomy === "full"
      ? "Autonomie complète : une fois vérifié, tu peux merger ta branche (`git merge --no-ff`) dans la branche déployée et pousser (= mise en prod), en respectant AGENTS.md/CLAUDE.md du dépôt, puis vérifier en réel (URL, logs, statut du déploiement)."
      : autonomy === "pr"
        ? "Autonomie PR : pousse ta branche et ouvre une PR (`gh pr create`), sans merger ni déployer."
        : "Lecture seule : n'écris rien dans le dépôt, rapporte seulement.";
  return [
    `Tu es un agent lancé par Novabot (l'orchestrateur de ${owner()}). Tutoie ${owner()}, écris en ${lang()}.`,
    `Contexte : projet ${project?.name ?? "(aucun)"} — dossier de travail ${cwd}${branch ? `, branche ${branch} (worktree dédié, déjà créée)` : ""}.`,
    project?.stack ? `Stack : ${project.stack}.` : "",
    project?.notes ? `Fiche projet :\n${project.notes}` : "",
    o.context ? `Mémoire et passation :\n${o.context.slice(0, 6000)}` : "",
    ``,
    `Objectif de cette tâche : ${task.goal}`,
    task.doneCriteria ? `Fini quand : ${task.doneCriteria}` : `Fini quand : l'objectif est atteint et vérifié par toi-même (tests, build, commande, URL).`,
    ``,
    `Contraintes :`,
    `- Lis AGENTS.md / CLAUDE.md du dépôt s'ils existent. Travaille sur ${branch ?? "une branche dédiée"}, jamais directement sur main/master.`,
    `- ${auto}`,
    `- Ne supprime rien de destructif, ne touche ni au DNS, ni au billing, ni aux secrets : pour ça, appelle l'outil MCP novabot \`ask_owner\` (une question + ta recommandation) et arrête-toi.`,
    `- Arrête à la fin les serveurs Vite/Chrome headless/dev que tu as lancés (le serveur est partagé).`,
    `- Progression : appelle \`task_update\` (MCP novabot) aux étapes clés.`,
    `- Fin : vérifie toi-même, commit, puis appelle \`task_done\` avec un résumé et la PREUVE (commandes lancées et leur résultat, fichiers modifiés, URL vérifiée). Termine aussi ta réponse par ce résumé.`,
  ].filter(Boolean).join("\n");
}

export function fixPrompt(reason: string, fix: string | null): string {
  return [
    `[Novabot — vérification] La tâche n'est pas encore validée.`,
    `Problème constaté : ${reason}`,
    fix ? `Attendu : ${fix}` : "",
    `Corrige, vérifie toi-même, commit, puis rappelle \`task_done\` avec la preuve.`,
  ].filter(Boolean).join("\n");
}

export function answerPrompt(answer: string): string {
  return `[Novabot] Réponse de ${owner()} à ta question : ${answer}\nReprends la tâche avec cette décision, puis termine par \`task_done\` avec la preuve.`;
}

export function reviewPrompt(o: { task: Task; base: string; cwd: string }): string {
  return [
    `Tu es relecteur pour Novabot. Dossier ${o.cwd}. Relis le travail fait pour : ${o.task.goal}`,
    `Diff à relire : \`git diff ${o.base}...HEAD\` (et \`git log ${o.base}..HEAD\`). Ne modifie aucun fichier.`,
    `Cherche les bugs réels, régressions, failles et critères non remplis${o.task.doneCriteria ? ` (critère : ${o.task.doneCriteria})` : ""}. Pas de remarques de style.`,
    `Termine ta réponse par une ligne exactement de la forme \`VERDICT: OK\` ou \`VERDICT: KO — <problèmes à corriger>\`.`,
  ].join("\n");
}

export function verifyPrompt(o: { task: Task; git: string; output: string; agentDone: { summary?: string; evidence?: string } | null }): { system: string; prompt: string } {
  return {
    system:
      "Tu es le vérificateur de Novabot. Tu juges si une tâche confiée à un agent de code est réellement terminée, à partir de preuves. Sois exigeant mais pragmatique : une preuve concrète (test vert, commande, URL vérifiée, commit) suffit. Réponds UNIQUEMENT en JSON : " +
      `{"verdict":"done"|"fix"|"blocked","reason":"…","fix":"ce que l'agent doit faire (si fix)","question":"question pour ${owner()} (si blocked)"}. ` +
      `blocked = seulement si une décision réservée à ${owner()} (suppression, DNS, billing, secret manquant) bloque.`,
    prompt: [
      `Tâche : ${o.task.title}`,
      `Objectif : ${o.task.goal}`,
      `Critère de fin : ${o.task.doneCriteria ?? "(non précisé : objectif atteint et vérifié)"}`,
      `Déclaration de l'agent (task_done) : ${o.agentDone ? `résumé=${o.agentDone.summary}\npreuve=${o.agentDone.evidence}` : "aucune (l'agent s'est arrêté sans appeler task_done)"}`,
      `État git :\n${o.git.slice(0, 4000)}`,
      `Fin de la sortie de l'agent :\n${o.output.slice(-6000)}`,
    ].join("\n\n"),
  };
}

export function parseVerdict(s: string): { verdict: "done" | "fix" | "blocked"; reason: string; fix?: string; question?: string } | null {
  const i = s.indexOf("{"); const j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    const v = JSON.parse(s.slice(i, j + 1));
    if (!["done", "fix", "blocked"].includes(v.verdict)) return null;
    return { verdict: v.verdict, reason: String(v.reason ?? ""), fix: v.fix ? String(v.fix) : undefined, question: v.question ? String(v.question) : undefined };
  } catch { return null; }
}
