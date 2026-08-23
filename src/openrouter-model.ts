import type { Model } from "@earendil-works/pi-ai";

export const OX_ALPHA_MODEL = "stealth/ox-alpha";
export const FALLBACK_MODEL = "openai/gpt-5.6-luna";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PRICE_CHECK_TIMEOUT_MS = 5_000;

interface OpenRouterModelRecord {
  id?: unknown;
  name?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
  };
  top_provider?: {
    max_completion_tokens?: unknown;
  };
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

export interface FreeOxAlphaListing {
  id: typeof OX_ALPHA_MODEL;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
}

export async function confirmFreeOxAlpha(
  fetcher: typeof fetch = fetch
): Promise<FreeOxAlphaListing | undefined> {
  try {
    const response = await fetcher(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PRICE_CHECK_TIMEOUT_MS)
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as OpenRouterModelsResponse;
    if (!Array.isArray(payload.data)) return undefined;
    const record = payload.data.find(
      (candidate): candidate is OpenRouterModelRecord =>
        typeof candidate === "object" && candidate !== null && candidate.id === OX_ALPHA_MODEL
    );
    if (!record || !isZeroPrice(record.pricing?.prompt) || !isZeroPrice(record.pricing?.completion)) {
      return undefined;
    }

    const inputModalities = Array.isArray(record.architecture?.input_modalities)
      ? record.architecture.input_modalities.filter(
          (value): value is "text" | "image" => value === "text" || value === "image"
        )
      : [];

    return {
      id: OX_ALPHA_MODEL,
      name: typeof record.name === "string" ? record.name : "Ox Alpha",
      contextWindow: positiveInteger(record.context_length, 1_048_576),
      maxTokens: positiveInteger(record.top_provider?.max_completion_tokens, 131_072),
      input: inputModalities.length > 0 ? inputModalities : ["text"]
    };
  } catch {
    return undefined;
  }
}

export function createOxAlphaModel(
  template: Model<any>,
  listing: FreeOxAlphaListing
): Model<any> {
  return {
    ...template,
    id: listing.id,
    name: listing.name,
    reasoning: true,
    input: listing.input,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: listing.contextWindow,
    maxTokens: listing.maxTokens
  };
}

function isZeroPrice(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value === 0;
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
