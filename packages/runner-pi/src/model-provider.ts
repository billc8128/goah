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

export function createPiModel(provider: string, modelId: string): {
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
    const baseUrl = process.env.GOAH_PI_BASE_URL ?? ARK_CODING_BASE_URL;
    const arkModel: Model<"openai-responses"> = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider,
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 32_000,
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
    const faux = fauxProvider({ provider, models: [{ id: modelId }] });
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() as Model<Api>, faux };
  } else {
    throw new Error(`unsupported GOAH Pi provider: ${provider}`);
  }
  if (!model) throw new Error(`Pi model not found: ${provider}/${modelId}`);
  return { models, model };
}

export function providerApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "ark-coding") return process.env.ARK_API_KEY;
  return undefined;
}
