import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const ARK_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokensPerTurn: number;
}

export function createPiModel(provider: string, modelId: string, env: NodeJS.ProcessEnv = process.env): {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
  faux?: ReturnType<typeof fauxProvider>;
} {
  const models = createModels();
  let model: Model<Api> | undefined;
  if (provider === "anthropic") {
    models.setProvider(anthropicProvider());
    model = models.getModel(provider, modelId);
  } else if (provider === "openai") {
    models.setProvider(openaiProvider());
    model = models.getModel(provider, modelId);
  } else if (provider === "ark-coding") {
    const baseUrl = env.GOAH_PI_BASE_URL ?? ARK_CODING_BASE_URL;
    const capabilities = parseModelCapabilities(env.GOAH_PI_MODEL_CAPABILITIES);
    const arkModel: Model<"openai-responses"> = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider,
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: capabilities.contextWindowTokens,
      maxTokens: capabilities.maxOutputTokensPerTurn,
      compat: { supportsDeveloperRole: false },
    };
    models.setProvider(createProvider({
      id: provider,
      name: "Ark Coding Plan",
      baseUrl,
      auth: { apiKey: envApiKeyAuth("Ark API key", ["ARK_API_KEY"]) },
      models: [arkModel],
      api: openAIResponsesApi(),
    }));
    model = models.getModel(provider, modelId);
  } else if (provider === "faux") {
    const faux = fauxProvider({ provider, models: [{ id: modelId, contextWindow: 128_000, maxTokens: 32_000 }] });
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() as Model<Api>, faux };
  } else {
    throw new Error(`unsupported GOAH Pi provider: ${provider}`);
  }
  if (!model) throw new Error(`Pi model not found: ${provider}/${modelId}`);
  return { models, model };
}

export function parseModelCapabilities(value: string | undefined): ModelCapabilities {
  if (value === undefined) throw new Error("GOAH_PI_MODEL_CAPABILITIES is required for ark-coding");
  const parsed = JSON.parse(value) as Partial<ModelCapabilities>;
  if (!Number.isInteger(parsed.contextWindowTokens) || parsed.contextWindowTokens! <= 0
    || !Number.isInteger(parsed.maxOutputTokensPerTurn) || parsed.maxOutputTokensPerTurn! <= 0
    || parsed.maxOutputTokensPerTurn! >= parsed.contextWindowTokens!) {
    throw new Error("invalid GOAH_PI_MODEL_CAPABILITIES");
  }
  return parsed as ModelCapabilities;
}

export function providerApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "ark-coding") return process.env.ARK_API_KEY;
  return undefined;
}
