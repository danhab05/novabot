import type { ToolDef, ToolContext } from "@novabot/shared";

export type Tier = "fast" | "reason" | "critical";
export type ProviderId = "codex" | "claude";

/** Message d'historique simplifié transmis aux fournisseurs. */
export interface LlmMessage {
  role: "user" | "assistant";
  text: string;
  images?: { mime: string; dataBase64: string }[];
}

export interface CompleteReq { system?: string; prompt: string; tier?: Tier; json?: boolean }

export interface AgentTurnReq {
  system: string;
  history: LlmMessage[]; // dernier = message de l'utilisateur
  tier: Tier;
  tools: ToolDef[];
  toolCtx: ToolContext;
  runTool: (name: string, input: unknown) => Promise<unknown>;
  onDelta?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  maxSteps?: number;
}
export interface AgentTurnRes { text: string; model: string; provider: ProviderId; toolCalls: { name: string; input: unknown; ok: boolean }[] }

export interface Provider {
  id: ProviderId;
  model(tier: Tier): string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  complete(req: CompleteReq): Promise<{ text: string; model: string }>;
  agentTurn(req: AgentTurnReq): Promise<AgentTurnRes>;
}

/** Erreur d'un fournisseur ; retryable = tenter l'autre famille. */
export class ProviderError extends Error {
  constructor(message: string, public provider: ProviderId, public retryable = true, public status?: number) { super(message); }
}

export type QuotaSink = (provider: ProviderId, window: "5h" | "7d", usedPct: number, resetsAt: number | null) => void;
