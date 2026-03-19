import { execSync, spawn } from "node:child_process";
import {
  definePluginEntry,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk/core";
import {
  applyAuthProfileConfig,
  createProviderApiKeyAuthMethod,
  ensureAuthProfileStore,
  upsertAuthProfile,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelCompatConfig, ModelProviderConfig } from "../../src/config/types.models.js";
import type { ProviderModelSelectedContext } from "../../src/plugins/types.js";

const PROVIDER_ID = "microsoft-foundry";
const DEFAULT_API = "openai-completions";
const DEFAULT_GPT5_API = "openai-responses";
const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execCmd(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function isAzCliInstalled(): boolean {
  try {
    // "az version" works on Windows, Linux, and macOS
    execCmd("az version --output none");
    return true;
  } catch {
    return false;
  }
}

interface AzAccount {
  name: string;
  id: string;
  tenantId?: string;
  user?: { name?: string };
  state?: string;
  isDefault?: boolean;
}

function getLoggedInAccount(): AzAccount | null {
  try {
    const raw = execCmd("az account show --output json");
    return JSON.parse(raw) as AzAccount;
  } catch {
    return null;
  }
}

function listSubscriptions(): AzAccount[] {
  try {
    const raw = execCmd("az account list --output json --all");
    const subs = JSON.parse(raw) as AzAccount[];
    return subs.filter((s) => s.state === "Enabled");
  } catch {
    return [];
  }
}

interface AzAccessToken {
  accessToken: string;
  expiresOn?: string;
}

interface AzCognitiveAccount {
  id: string;
  name: string;
  kind: string;
  location?: string;
  resourceGroup?: string;
  endpoint?: string | null;
  customSubdomain?: string | null;
  projects?: string[] | null;
}

interface FoundryResourceOption {
  id: string;
  accountName: string;
  kind: "AIServices" | "OpenAI";
  location?: string;
  resourceGroup: string;
  endpoint: string;
  projects: string[];
}

interface AzDeploymentSummary {
  name: string;
  modelName?: string;
  modelVersion?: string;
  state?: string;
  sku?: string;
}

type FoundryProviderApi = typeof DEFAULT_API | typeof DEFAULT_GPT5_API;

function quoteShellArg(value: string): string {
  return JSON.stringify(value);
}

function getAccessTokenResult(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): AzAccessToken {
  const targetArg = params?.subscriptionId
    ? ` --subscription ${JSON.stringify(params.subscriptionId)}`
    : params?.tenantId
      ? ` --tenant ${JSON.stringify(params.tenantId)}`
      : "";
  const raw = execCmd(
    `az account get-access-token --resource ${COGNITIVE_SERVICES_RESOURCE} --output json${targetArg}`,
  );
  return JSON.parse(raw) as AzAccessToken;
}

function buildAzureBaseUrl(endpoint: string, modelId: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  if (base.includes("/openai/deployments/")) return base;
  return `${base}/openai/deployments/${modelId}`;
}

function buildFoundryResponsesBaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}

function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/openai(?:\/v1|\/deployments\/[^/]+)?$/i, "");
}

function buildFoundryProviderBaseUrl(endpoint: string, modelId: string): string {
  return resolveFoundryApi(modelId) === DEFAULT_GPT5_API
    ? buildFoundryResponsesBaseUrl(endpoint)
    : buildAzureBaseUrl(endpoint, modelId);
}

function extractFoundryEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return undefined;
  }
}

function isGpt5FamilyDeployment(modelId: string): boolean {
  return /^gpt-5(?:$|[-.])/i.test(modelId.trim());
}

function resolveFoundryApi(modelId: string): FoundryProviderApi {
  return isGpt5FamilyDeployment(modelId) ? DEFAULT_GPT5_API : DEFAULT_API;
}

function buildFoundryModelCompat(modelId: string): ModelCompatConfig | undefined {
  if (!isGpt5FamilyDeployment(modelId)) {
    return undefined;
  }
  return {
    maxTokensField: "max_completion_tokens",
  };
}

function buildFoundryProviderConfig(endpoint: string, modelId: string): ModelProviderConfig {
  const compat = buildFoundryModelCompat(modelId);
  return {
    baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId),
    api: resolveFoundryApi(modelId),
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...(compat ? { compat } : {}),
      },
    ],
  };
}

function normalizeEndpointOrigin(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

function listFoundryResources(): FoundryResourceOption[] {
  try {
    const raw = execCmd(
      'az cognitiveservices account list --query "[].{id:id,name:name,kind:kind,location:location,resourceGroup:resourceGroup,endpoint:properties.endpoint,customSubdomain:properties.customSubDomainName,projects:properties.associatedProjects}" --output json',
    );
    const accounts = JSON.parse(raw) as AzCognitiveAccount[];
    const resources: FoundryResourceOption[] = [];
    for (const account of accounts) {
      if (!account.resourceGroup) {
        continue;
      }
      if (account.kind === "OpenAI") {
        const endpoint = normalizeEndpointOrigin(account.endpoint);
        if (!endpoint) {
          continue;
        }
        resources.push({
          id: account.id,
          accountName: account.name,
          kind: "OpenAI",
          location: account.location,
          resourceGroup: account.resourceGroup,
          endpoint,
          projects: [],
        });
        continue;
      }
      if (account.kind !== "AIServices") {
        continue;
      }
      const endpoint = account.customSubdomain?.trim()
        ? `https://${account.customSubdomain.trim()}.services.ai.azure.com`
        : undefined;
      if (!endpoint) {
        continue;
      }
      resources.push({
        id: account.id,
        accountName: account.name,
        kind: "AIServices",
        location: account.location,
        resourceGroup: account.resourceGroup,
        endpoint,
        projects: Array.isArray(account.projects)
          ? account.projects.filter((project): project is string => typeof project === "string")
          : [],
      });
    }
    return resources;
  } catch {
    return [];
  }
}

function listResourceDeployments(resource: FoundryResourceOption): AzDeploymentSummary[] {
  try {
    const raw = execCmd(
      `az cognitiveservices account deployment list -g ${quoteShellArg(resource.resourceGroup)} -n ${quoteShellArg(resource.accountName)} --query "[].{name:name,modelName:properties.model.name,modelVersion:properties.model.version,state:properties.provisioningState,sku:sku.name}" --output json`,
    );
    const deployments = JSON.parse(raw) as AzDeploymentSummary[];
    return deployments.filter((deployment) => deployment.state === "Succeeded");
  } catch {
    return [];
  }
}

async function selectFoundryResource(
  ctx: ProviderAuthContext,
  selectedSub: AzAccount,
): Promise<FoundryResourceOption> {
  const resources = listFoundryResources();
  if (resources.length === 0) {
    throw new Error(buildCreateFoundryHint(selectedSub));
  }
  if (resources.length === 1) {
    const only = resources[0]!;
    await ctx.prompter.note(
      `Using ${only.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"} resource: ${only.accountName}`,
      "Foundry Resource",
    );
    return only;
  }
  const selectedResourceId = await ctx.prompter.select({
    message: "Select Azure AI Foundry / Azure OpenAI resource",
    options: resources.map((resource) => ({
      value: resource.id,
      label: `${resource.accountName} (${resource.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"}${resource.location ? `, ${resource.location}` : ""})`,
      hint: [
        `RG: ${resource.resourceGroup}`,
        resource.projects.length > 0 ? `${resource.projects.length} project(s)` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
    })),
  });
  return resources.find((resource) => resource.id === selectedResourceId) ?? resources[0]!;
}

async function selectFoundryDeployment(
  ctx: ProviderAuthContext,
  resource: FoundryResourceOption,
): Promise<AzDeploymentSummary> {
  const deployments = listResourceDeployments(resource);
  if (deployments.length === 0) {
    throw new Error(
      [
        `No model deployments were found in ${resource.accountName}.`,
        "Deploy a model in Azure AI Foundry or Azure OpenAI, then rerun onboard.",
      ].join("\n"),
    );
  }
  if (deployments.length === 1) {
    const only = deployments[0]!;
    await ctx.prompter.note(`Using deployment: ${only.name}`, "Model Deployment");
    return only;
  }
  const selectedDeploymentName = await ctx.prompter.select({
    message: "Select model deployment",
    options: deployments.map((deployment) => ({
      value: deployment.name,
      label: deployment.name,
      hint: [deployment.modelName, deployment.modelVersion, deployment.sku].filter(Boolean).join(" | "),
    })),
  });
  return deployments.find((deployment) => deployment.name === selectedDeploymentName) ?? deployments[0]!;
}

function buildCreateFoundryHint(selectedSub: AzAccount): string {
  return [
    `No Azure AI Foundry or Azure OpenAI resources were found in subscription ${selectedSub.name} (${selectedSub.id}).`,
    "Create one in Azure AI Foundry or Azure Portal, then rerun onboard.",
    "Azure AI Foundry: https://ai.azure.com",
    "Azure OpenAI docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource",
  ].join("\n");
}

async function promptEndpointAndModelManually(ctx: ProviderAuthContext): Promise<{
  endpoint: string;
  modelId: string;
}> {
  const endpoint = String(
    await ctx.prompter.text({
      message: "Microsoft Foundry endpoint URL",
      placeholder: "https://xxx.openai.azure.com or https://xxx.services.ai.azure.com",
      validate: (v) => {
        const val = String(v ?? "").trim();
        if (!val) return "Endpoint URL is required";
        try {
          new URL(val);
        } catch {
          return "Invalid URL";
        }
        return undefined;
      },
    }),
  ).trim();
  const modelId = String(
    await ctx.prompter.text({
      message: "Default model/deployment name",
      placeholder: "gpt-4o",
      validate: (v) => {
        const val = String(v ?? "").trim();
        if (!val) return "Model ID is required";
        return undefined;
      },
    }),
  ).trim();
  return { endpoint, modelId };
}

/**
 * Interactive az login using device-code flow.
 * Spawns az login so terminal output (device code URL) is visible to user.
 */
async function azLoginDeviceCode(): Promise<void> {
  return azLoginDeviceCodeWithOptions({});
}

async function azLoginDeviceCodeWithOptions(params: {
  tenantId?: string;
  allowNoSubscriptions?: boolean;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "login",
      "--use-device-code",
      ...(params.tenantId ? ["--tenant", params.tenantId] : []),
      ...(params.allowNoSubscriptions ? ["--allow-no-subscriptions"] : []),
    ];
    const child = spawn("az", args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`az login exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function extractTenantSuggestions(rawMessage: string): Array<{ id: string; label?: string }> {
  const suggestions: Array<{ id: string; label?: string }> = [];
  const seen = new Set<string>();
  const regex = /([0-9a-fA-F-]{36})(?:\s+'([^'\r\n]+)')?/g;
  for (const match of rawMessage.matchAll(regex)) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    suggestions.push({
      id,
      ...(match[2]?.trim() ? { label: match[2].trim() } : {}),
    });
  }
  return suggestions;
}

async function promptTenantId(
  ctx: ProviderAuthContext,
  params?: {
    suggestions?: Array<{ id: string; label?: string }>;
    required?: boolean;
    reason?: string;
  },
): Promise<string | undefined> {
  const suggestionLines =
    params?.suggestions && params.suggestions.length > 0
      ? params.suggestions.map((entry) => `- ${entry.id}${entry.label ? ` (${entry.label})` : ""}`)
      : [];
  if (params?.reason || suggestionLines.length > 0) {
    await ctx.prompter.note(
      [
        params?.reason,
        suggestionLines.length > 0 ? "Suggested tenants:" : undefined,
        ...suggestionLines,
      ]
        .filter(Boolean)
        .join("\n"),
      "Azure Tenant",
    );
  }
  const tenantId = String(
    await ctx.prompter.text({
      message: params?.required
        ? "Azure tenant ID"
        : "Azure tenant ID (optional)",
      placeholder: params?.suggestions?.[0]?.id ?? "00000000-0000-0000-0000-000000000000",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) {
          return params?.required ? "Tenant ID is required" : undefined;
        }
        return /^[0-9a-fA-F-]{36}$/.test(trimmed) ? undefined : "Enter a valid tenant ID";
      },
    }),
  ).trim();
  return tenantId || undefined;
}

async function loginWithTenantFallback(ctx: ProviderAuthContext): Promise<{
  account: AzAccount | null;
  tenantId?: string;
}> {
  try {
    await azLoginDeviceCode();
    return { account: getLoggedInAccount() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tenantId = await promptTenantId(ctx, {
      suggestions: extractTenantSuggestions(message),
      required: true,
      reason:
        "Azure login needs a tenant-scoped retry. This often happens when your tenant requires MFA or your account has no Azure subscriptions.",
    });
    await azLoginDeviceCodeWithOptions({
      tenantId,
      allowNoSubscriptions: true,
    });
    return {
      account: getLoggedInAccount(),
      tenantId,
    };
  }
}

// ---------------------------------------------------------------------------
// Entra ID auth method
// ---------------------------------------------------------------------------

const entraIdAuthMethod = {
  id: "entra-id",
  label: "Entra ID (az login)",
  hint: "Use your Azure login — no API key needed",
  kind: "custom" as const,
  wizard: {
    choiceId: "microsoft-foundry-entra",
    choiceLabel: "Microsoft Foundry (Entra ID / az login)",
    choiceHint: "Use your Azure login — no API key needed",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    // 1. Check az CLI
    if (!isAzCliInstalled()) {
      throw new Error(
        "Azure CLI (az) is not installed.\n" +
          "Install it from https://learn.microsoft.com/cli/azure/install-azure-cli",
      );
    }

    // 2. Check login status
    let account = getLoggedInAccount();
    let tenantId = account?.tenantId;
    if (account) {
      const useExisting = await ctx.prompter.confirm({
        message: `Already logged in as ${account.user?.name ?? "unknown"} (${account.name}). Use this account?`,
        initialValue: true,
      });
      if (!useExisting) {
        const loginResult = await loginWithTenantFallback(ctx);
        account = loginResult.account;
        tenantId = loginResult.tenantId ?? loginResult.account?.tenantId;
      }
    } else {
      await ctx.prompter.note(
        "You need to log in to Azure. A device code will be displayed — follow the instructions.",
        "Azure Login",
      );
      const loginResult = await loginWithTenantFallback(ctx);
      account = loginResult.account;
      tenantId = loginResult.tenantId ?? loginResult.account?.tenantId;
    }

    // 3. List and select subscription
    const subs = listSubscriptions();
    let selectedSub: AzAccount | null = null;
    if (subs.length === 0) {
      tenantId ??= await promptTenantId(ctx, {
        required: true,
        reason:
          "No enabled Azure subscriptions were found. Continue with tenant-scoped Entra ID auth instead.",
      });
      await ctx.prompter.note(
        `Continuing with tenant-scoped auth (${tenantId}).`,
        "Azure Tenant",
      );
    } else if (subs.length === 1) {
      selectedSub = subs[0]!;
      tenantId ??= selectedSub.tenantId;
      await ctx.prompter.note(
        `Using subscription: ${selectedSub.name} (${selectedSub.id})`,
        "Subscription",
      );
    } else {
      const choices = subs.map((s) => ({
        value: s.id,
        label: `${s.name} (${s.id})`,
      }));
      const selectedId = await ctx.prompter.select({
        message: "Select Azure subscription",
        options: choices,
      });
      selectedSub = subs.find((s) => s.id === selectedId)!;
      tenantId ??= selectedSub.tenantId;
    }

    // 4. Set subscription
    if (selectedSub) {
      execCmd(`az account set --subscription "${selectedSub.id}"`);
    }

    // 5. Discover resource + deployment when possible
    let endpoint: string;
    let modelId: string;
    if (selectedSub) {
      const useDiscoveredResource = await ctx.prompter.confirm({
        message: "Discover Microsoft Foundry resources from this subscription?",
        initialValue: true,
      });
      if (useDiscoveredResource) {
        const selectedResource = await selectFoundryResource(ctx, selectedSub);
        const selectedDeployment = await selectFoundryDeployment(ctx, selectedResource);
        endpoint = selectedResource.endpoint;
        modelId = selectedDeployment.name;
        await ctx.prompter.note(
          [
            `Resource: ${selectedResource.accountName}`,
            `Endpoint: ${endpoint}`,
            `Deployment: ${modelId}`,
          ].join("\n"),
          "Microsoft Foundry",
        );
      } else {
        ({ endpoint, modelId } = await promptEndpointAndModelManually(ctx));
      }
    } else {
      ({ endpoint, modelId } = await promptEndpointAndModelManually(ctx));
    }

    // 7. Test connection
    try {
      const { accessToken } = getAccessTokenResult({
        subscriptionId: selectedSub?.id,
        tenantId,
      });
      const testUrl = `${buildAzureBaseUrl(endpoint, modelId)}/chat/completions?api-version=2024-12-01-preview`;
      const res = await fetch(testUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
      });
      if (!res.ok && res.status !== 400) {
        const body = await res.text().catch(() => "");
        await ctx.prompter.note(
          `Warning: test request returned ${res.status}. ${body.slice(0, 200)}\nProceeding anyway — you can fix the endpoint later.`,
          "Connection Test",
        );
      } else {
        await ctx.prompter.note("Connection test successful!", "✓");
      }
    } catch (err) {
      await ctx.prompter.note(
        `Warning: connection test failed: ${String(err)}\nProceeding anyway.`,
        "Connection Test",
      );
    }

    // 8. Build result — store a placeholder key; prepareRuntimeAuth will
    //    replace it with a fresh Entra ID token at request time.
    const profileId = `${PROVIDER_ID}:entra`;

    return {
      profiles: [
        {
          profileId,
          credential: {
            type: "api_key",
            provider: PROVIDER_ID,
            // Placeholder — prepareRuntimeAuth refreshes this dynamically.
            key: "__entra_id_dynamic__",
            metadata: {
              authMethod: "entra-id",
              ...(selectedSub?.id ? { subscriptionId: selectedSub.id } : {}),
              ...(selectedSub?.name ? { subscriptionName: selectedSub.name } : {}),
              ...(tenantId ? { tenantId } : {}),
              endpoint,
              modelId,
            },
          },
        },
      ],
      configPatch: {
        models: {
          providers: {
            [PROVIDER_ID]: buildFoundryProviderConfig(endpoint, modelId),
          },
        },
      },
      defaultModel: `${PROVIDER_ID}/${modelId}`,
      notes: [
        ...(selectedSub?.name ? [`Subscription: ${selectedSub.name}`] : []),
        ...(tenantId ? [`Tenant: ${tenantId}`] : []),
        `Endpoint: ${endpoint}`,
        `Model: ${modelId}`,
        "Token is refreshed automatically via az CLI — keep az login active.",
      ],
    };
  },
  onModelSelected: async (ctx: ProviderModelSelectedContext) => {
    const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
    if (!providerConfig || !ctx.model.startsWith(`${PROVIDER_ID}/`)) {
      return;
    }
    const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
    const selectedModelCompat = buildFoundryModelCompat(selectedModelId);
    const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
    const nextProviderConfig: ModelProviderConfig = {
      ...providerConfig,
      baseUrl: buildFoundryProviderBaseUrl(providerEndpoint, selectedModelId),
      api: resolveFoundryApi(selectedModelId),
      models: [
        {
          ...(providerConfig.models.find((model: { id: string }) => model.id === selectedModelId) ?? {
            id: selectedModelId,
            name: selectedModelId,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
          }),
          ...(selectedModelCompat ? { compat: selectedModelCompat } : {}),
        },
      ],
    };
    applyAuthProfileConfig(ctx.config, {
      profileId: `${PROVIDER_ID}:entra`,
      provider: PROVIDER_ID,
      mode: "api_key",
    });
    ctx.config.models ??= {};
    ctx.config.models.providers ??= {};
    ctx.config.models.providers[PROVIDER_ID] = nextProviderConfig;
  },
};

// ---------------------------------------------------------------------------
// API Key auth method
// ---------------------------------------------------------------------------

const apiKeyAuthMethod = createProviderApiKeyAuthMethod({
  providerId: PROVIDER_ID,
  methodId: "api-key",
  label: "Azure OpenAI API key",
  hint: "Direct Azure OpenAI API key",
  optionKey: "azureOpenaiApiKey",
  flagName: "--azure-openai-api-key",
  envVar: "AZURE_OPENAI_API_KEY",
  promptMessage: "Enter Azure OpenAI API key",
  defaultModel: `${PROVIDER_ID}/gpt-4o`,
  expectedProviders: [PROVIDER_ID],
  wizard: {
    choiceId: "microsoft-foundry-apikey",
    choiceLabel: "Microsoft Foundry (API key)",
    groupId: "microsoft-foundry",
    groupLabel: "Microsoft Foundry",
    groupHint: "Entra ID + API key",
  },
});

// ---------------------------------------------------------------------------
// Token cache for prepareRuntimeAuth
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

function refreshEntraToken(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): { apiKey: string; expiresAt: number } {
  const result = getAccessTokenResult(params);
  const expiresAt = result.expiresOn
    ? new Date(result.expiresOn).getTime()
    : Date.now() + 55 * 60 * 1000; // default ~55 min
  cachedToken = { token: result.accessToken, expiresAt };
  return { apiKey: result.accessToken, expiresAt };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Microsoft Foundry Provider",
  description: "Microsoft Foundry provider with Entra ID and API key auth",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Microsoft Foundry",
      docsPath: "/providers/azure",
      envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
      auth: [entraIdAuthMethod, apiKeyAuthMethod],
      capabilities: {
        providerFamily: "openai",
      },
      normalizeResolvedModel: ({ modelId, model }) => {
        const endpoint = extractFoundryEndpoint(model.baseUrl ?? "");
        if (!endpoint) {
          return model;
        }
        const compat = buildFoundryModelCompat(modelId);
        return {
          ...model,
          api: resolveFoundryApi(modelId),
          baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId),
          ...(compat ? { compat } : {}),
        };
      },
      prepareRuntimeAuth: async (ctx) => {
        // Only intercept Entra ID auth (placeholder key).
        // API key users pass through unchanged.
        if (ctx.apiKey !== "__entra_id_dynamic__") {
          return null; // let default handling apply
        }

        // Return cached token if still valid
        try {
          const authStore = ensureAuthProfileStore(ctx.agentDir, {
            allowKeychainPrompt: false,
          });
          const credential = ctx.profileId ? authStore.profiles[ctx.profileId] : undefined;
          const metadata = credential?.type === "api_key" ? credential.metadata : undefined;
          const modelId =
            typeof ctx.modelId === "string" && ctx.modelId.trim().length > 0
              ? ctx.modelId.trim()
              : typeof metadata?.modelId === "string" && metadata.modelId.trim().length > 0
                ? metadata.modelId.trim()
                : ctx.modelId;
          const endpoint =
            typeof metadata?.endpoint === "string" && metadata.endpoint.trim().length > 0
              ? metadata.endpoint.trim()
              : extractFoundryEndpoint(ctx.model.baseUrl ?? "");
          const baseUrl = endpoint ? buildFoundryProviderBaseUrl(endpoint, modelId) : undefined;

          // Return cached token if still valid
          if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
            return {
              apiKey: cachedToken.token,
              expiresAt: cachedToken.expiresAt,
              ...(baseUrl ? { baseUrl } : {}),
            };
          }

          // Refresh via az CLI
          const token = refreshEntraToken({
            subscriptionId: metadata?.subscriptionId,
            tenantId: metadata?.tenantId,
          });
          return {
            ...token,
            ...(baseUrl ? { baseUrl } : {}),
          };
        } catch (err) {
          throw new Error(
            `Failed to refresh Azure Entra ID token via az CLI: ${String(err)}\n` +
              "Make sure you are logged in: az login --use-device-code",
          );
        }
      },
    });
  },
});
