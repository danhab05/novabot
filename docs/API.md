# Novabot — contrat d'API (v0.1)

Toutes les routes `/api/*` et `/internal/*` exigent une session (cookie `nb_session`)
ou `Authorization: Bearer $NOVABOT_INTERNAL_TOKEN` (= admin). Réponses JSON. Erreurs : `{ error }`.
Types : `packages/shared/src/index.ts`. Évènements temps réel : SSE `GET /api/events`
(`event: nova`, `data: NovaEvent`), keep-alive `event: ping` toutes les 25 s.

## Cœur (daemon — fait)
| Méthode | Route | Corps / réponse |
|---|---|---|
| GET | /api/me | User |
| POST | /api/auth/logout | |
| GET | /api/bootstrap | `{ user, folders, projects, activeTasks, features[] }` |
| POST/PATCH | /api/folders, /api/projects, /api/projects/:id | admin |
| GET | /api/projects/:id/members | User[] |
| GET/POST | /api/threads?projectId= | Thread[] / `{projectId,title}` → Thread |
| GET | /api/threads/:id/messages?before=<ts> | Message[] (80 max, ordre chrono) |
| POST | /api/threads/:id/messages | `{ content, meta? }` → Message (le cerveau répond en async via SSE) |
| GET | /api/tasks?status=a,b&projectId= | Task[] |
| GET | /api/tasks/:id | `{ task, events: TaskEvent[] }` |
| POST | /api/tasks/:id/cancel, /api/tasks/:id/answer `{answer}` | |
| GET | /api/orchestrator | statut file + ressources |
| GET/POST | /internal/tools, /internal/tools/:name | registre d'outils (MCP) ; en-têtes `x-nova-project/thread/task` |
| GET | /auth/dev?token= | session admin de secours (public) |
| GET | /healthz | public |

## Cerveau + mémoire (packages/brain)
| GET | /api/memories?projectId=&q=&kind= | Memory[] |
| POST | /api/memories | `{scope, projectId?, kind, content}` |
| PATCH | /api/memories/:id | `{content?, pinned?}` |
| DELETE | /api/memories/:id | |
| GET | /api/memory/journal?limit= | MemoryJournalEntry[] (+ `content` courant) |
| GET | /api/skills/proposals | SkillProposal[] |
| POST | /api/skills/proposals/:id/accept, /reject | |
| POST | /api/uploads | multipart `file` → `{ url, name, mime, size }` (servi en GET /api/uploads/:name) |
| POST | /api/voice/stt | corps audio brut (`content-type: audio/*`) → `{ text }` |
| POST | /api/voice/tts | `{ text }` → audio/mpeg |
| GET | /api/brain/providers | état des fournisseurs (codex, claude) |

## Orchestrateur Herdr (packages/herdr)
| GET | /api/tasks/:id/terminal?lines= | `{ text, pane, agent, state }` (lecture du panneau Herdr) |
| POST | /api/tasks/:id/terminal/input | `{ text }` → envoyé à l'agent (admin) |
| GET | /api/herdr/agents | agents Herdr connus |

## Discord + notifications push (packages/discord)
| GET | /auth/discord | public → redirection OAuth Discord |
| GET | /auth/discord/callback | public → session puis `/` |
| GET | /api/push/vapid | `{ publicKey }` |
| POST | /api/push/subscribe | PushSubscription JSON |
| GET | /api/discord/status | état du bot |

## Navigateur live (packages/browser)
| WS | /api/browser/ws | protocole `BrowserClientMsg` / `BrowserServerMsg` (shared) — admin seulement |
| GET | /api/browser/tabs | onglets |

## Proactivité (packages/proactive)
| GET/POST | /api/crons | Cron[] / création |
| PATCH/DELETE | /api/crons/:id | |
| GET | /api/health | HealthCheck[] |
| GET | /api/quotas | Quota[] |
| GET | /api/ideas | Idea[] ; PATCH /api/ideas/:id `{status}` |
| POST | /api/brief/run | déclenche le brief maintenant |

## Catalogue + intégrations (packages/catalog)
| GET | /api/catalog?type= | CatalogItem[] |
| POST | /api/catalog/:id/install, /uninstall | `{ secrets? }` |
| POST | /api/catalog/:id/publish | publication publique (contrôle des secrets) |
| GET | /api/integrations | état Gmail/Agenda/Drive/Yahoo/WhatsApp |
| GET | /auth/google?scope=gmail,calendar,drive | public, OAuth Google |
| GET | /pub/catalogue, /pub/catalogue/:id.json | page publique + manifeste (public) |

## Sessions Herdr par projet (packages/herdr/src/sessions.ts) — admin
| GET | /api/sessions | toutes les sessions agent Herdr `{paneId, workspaceId, kind, name, status, cwd, title, novabot, sessionId, revision, projectId}` |
| GET | /api/projects/:id/sessions?kind=claude\|codex | sessions dont le cwd est dans le dossier du projet |
| POST | /api/projects/:id/sessions | `{kind}` → nouvelle session interactive `{paneId, name, kind}` |
| GET | /api/sessions/:pane/screen?source=visible\|recent&lines= | `{ ansi, status, title, revision, rows }` (paneId URL-encodé, ex. `wK7%3Ap1`) |
| POST | /api/sessions/:pane/input | `{ text?, keys?: ["enter","esc","tab","backspace","up","down","left","right","ctrl+c","shift+tab",…], submit? }` |
