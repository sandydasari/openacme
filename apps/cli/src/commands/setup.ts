import * as p from "@clack/prompts";
import gradient from "gradient-string";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveDataDir,
  readRawConfig,
  writeRawConfig,
  type Provider,
  type AuthMode,
} from "@openacme/config";
import {
  listProviders,
  MODEL_PRESETS,
  CUSTOM_MODEL_ID,
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderInfo,
} from "@openacme/llm-provider";
import {
  oauthLoginOpenAI,
  loginWithClaudeCodeCredentials,
  loginWithSetupToken,
  looksHeadless,
} from "@openacme/auth";
import { startCommand } from "./start.js";

/**
 * Interactive setup wizard: provider → auth → default model → config.yaml.
 *
 * Setup never creates agents. On first boot the daemon materializes the
 * Acme platform agent; everything else is hired through the web UI (new
 * agent or catalog import), where roles and personas actually live.
 */
export async function setupCommand(opts: { dataDir?: string }) {
  const dataDir = resolveDataDir(opts.dataDir);

  console.log();
  const coolGradient = gradient(["#0ea5e9", "#7dd3fc", "#ffffff"]);
  p.intro(coolGradient("OpenAcme Setup"));

  p.note(`Data directory: ${dataDir}`, "Configuration");

  // 1. Provider
  const providers = listProviders();
  const providerId = await p.select<Provider>({
    message: "Choose your LLM provider",
    options: providers.map((prov) => ({
      value: prov.id,
      label: prov.name,
      hint: providerHint(prov),
    })),
  });
  if (p.isCancel(providerId)) return cancel();
  const provider = providers.find((pr) => pr.id === providerId)!;

  // 2. Auth
  const auth = await collectAuth(provider, dataDir);
  if (auth === "cancelled") return cancel();

  // 3. Model — auto-pick the recommended default for this provider; the
  // user can change it later in the web UI or config.yaml. `custom` is the
  // one case with no sensible default — fall back to the interactive picker.
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider.id];
  let modelId: string;
  if (defaultModel) {
    modelId = defaultModel;
  } else {
    const picked = await pickModel(provider.id);
    if (picked === "cancelled") return cancel();
    modelId = picked;
  }

  const modelConfig = {
    provider: provider.id as Provider,
    model: modelId,
    baseUrl: provider.defaultBaseUrl,
    auth: auth.mode as AuthMode,
    cacheTtl: "5m" as const,
  };

  // 4. Write config.yaml. The top-level `model` is the workforce default —
  // agents without an explicit per-agent model inherit it. On a re-run
  // with a different default already present, ask before flipping it;
  // the auth credentials are saved either way.
  const existingConfig = readRawConfig(dataDir);
  const existingModel = existingConfig.model as
    | { provider?: string; model?: string }
    | undefined;
  let setDefault = true;
  if (
    existingModel?.provider &&
    (existingModel.provider !== modelConfig.provider ||
      existingModel.model !== modelConfig.model)
  ) {
    const confirm = await p.confirm({
      message: `Your current default model is ${existingModel.provider}/${existingModel.model}. Make ${provider.name}/${modelId} the new default?`,
    });
    if (p.isCancel(confirm)) return cancel();
    setDefault = confirm;
  }

  const spin = p.spinner();
  spin.start("Saving configuration");
  try {
    const merged: Record<string, unknown> = {
      ...existingConfig,
      ...(setDefault ? { model: modelConfig } : {}),
    };
    delete merged.agents;
    writeRawConfig(dataDir, merged);
  } catch (e) {
    spin.stop("Save failed");
    p.cancel(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  spin.stop("Configuration saved.");

  const summaryLines = [
    `Provider: ${provider.name}`,
    `Auth: ${auth.mode === "oauth" ? "OAuth subscription" : "API key"}`,
    setDefault
      ? `Default model: ${modelId}`
      : `Default model: unchanged (${existingModel?.provider}/${existingModel?.model})`,
    `Config: ${path.join(dataDir, "config.yaml")}`,
  ];
  if (auth.mode === "oauth")
    summaryLines.push(`Tokens: ${path.join(dataDir, "auth.json")}`);
  if (auth.mode === "api_key" && provider.envVar)
    summaryLines.push(`API key: ${path.join(dataDir, ".env")}`);
  summaryLines.push(
    `MCP servers: ${path.join(dataDir, "mcp.json")} — paste any Claude Desktop / Cursor config to add`
  );
  p.note(summaryLines.join("\n"), "Summary");

  // Offer to start the daemon right away. Headless setup skips the prompt and
  // leaves the user with the explicit `openacme start` instruction.
  if (!looksHeadless()) {
    const startNow = await p.confirm({
      message: "Start OpenAcme now?",
    });
    if (!p.isCancel(startNow) && startNow) {
      p.outro("Setup complete! Starting OpenAcme — Acme, your platform helper, will be ready.");
      await startCommand({ dataDir });
      return;
    }
  }

  p.outro(
    "Setup complete! Run `openacme start` — Acme, your platform helper, will be ready, and you can hire more agents from the web console."
  );
}

function providerHint(prov: ProviderInfo): string | undefined {
  if (prov.supportsOAuth) return "subscription or API key";
  if (prov.requiresApiKey) return prov.envVar;
  return "no key needed";
}

interface AuthResult {
  mode: AuthMode;
}

async function collectAuth(
  provider: ProviderInfo,
  dataDir: string,
): Promise<AuthResult | "cancelled"> {
  // Providers without OAuth support — skip the auth-method question entirely.
  if (!provider.supportsOAuth) {
    if (provider.requiresApiKey && provider.envVar) {
      const ok = await collectApiKey(dataDir, provider.envVar);
      if (ok === "cancelled") return "cancelled";
    }
    return { mode: "api_key" };
  }

  const method = await p.select<"oauth" | "api_key">({
    message: `How do you want to authenticate with ${provider.name}?`,
    options: [
      {
        value: "oauth",
        label: provider.id === "openai" ? "Sign in with ChatGPT" : "Sign in with Claude",
        hint: "use your subscription quota (recommended)",
      },
      {
        value: "api_key",
        label: "Use API key",
        hint: provider.envVar,
      },
    ],
  });
  if (p.isCancel(method)) return "cancelled";

  if (method === "oauth") {
    const ok = await runOAuthLogin(provider.id as "openai" | "anthropic", dataDir);
    if (ok === "cancelled") return "cancelled";
    return { mode: "oauth" };
  }

  if (provider.envVar) {
    const ok = await collectApiKey(dataDir, provider.envVar);
    if (ok === "cancelled") return "cancelled";
  }
  return { mode: "api_key" };
}

async function collectApiKey(dataDir: string, envVar: string): Promise<"ok" | "cancelled"> {
  const apiKey = await p.text({
    message: `Enter your ${envVar}`,
    placeholder: "sk-…",
    validate: (v) => {
      if (!v || !v.trim()) return "API key is required";
      if (v.trim().length < 10) return "API key seems too short";
      return undefined;
    },
  });
  if (p.isCancel(apiKey)) return "cancelled";

  const envPath = path.join(dataDir, ".env");
  const envLine = `${envVar}=${(apiKey as string).trim()}\n`;
  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, "utf-8");
    if (!existing.includes(`${envVar}=`)) {
      fs.appendFileSync(envPath, envLine);
    }
  } else {
    fs.writeFileSync(envPath, envLine);
  }
  return "ok";
}

async function runOAuthLogin(
  providerId: "openai" | "anthropic",
  dataDir: string,
): Promise<"ok" | "cancelled"> {
  if (providerId === "openai") {
    const flow = looksHeadless() ? "device" : "browser";
    const spin = p.spinner();
    spin.start(flow === "browser" ? "Opening browser to sign in with ChatGPT" : "Requesting device code");
    try {
      const result = await oauthLoginOpenAI({
        dataDir,
        flow,
        onAuthUrl: (url) => {
          if (flow === "browser") {
            spin.message(`If your browser didn't open, visit:\n  ${url}`);
          }
        },
        onDeviceCode: ({ userCode, verificationUri }) => {
          spin.stop("Device code ready");
          p.note(
            `1. Open: ${verificationUri}\n2. Enter code: ${userCode}\n3. Authorize OpenAcme.`,
            "Sign in with ChatGPT",
          );
          spin.start("Waiting for authorization (15 min timeout)");
        },
      });
      spin.stop(`Signed in${result.email ? ` as ${result.email}` : ""}.`);
      return "ok";
    } catch (e) {
      spin.stop("Sign-in failed");
      const msg = e instanceof Error ? e.message : String(e);
      p.cancel(msg);
      return "cancelled";
    }
  }

  // Anthropic: try Claude Code first, fall back to setup-token paste.
  const spin = p.spinner();
  spin.start("Looking for Claude Code credentials");
  let importError: string | undefined;
  const fromCC = await loginWithClaudeCodeCredentials(dataDir).catch((e) => {
    importError = e instanceof Error ? e.message : String(e);
    return null;
  });
  if (fromCC) {
    spin.stop("Imported Claude Code credentials.");
    return "ok";
  }
  spin.stop(importError ? "Claude Code credentials unusable." : "Claude Code not found.");

  p.note(
    (importError
      ? `${importError}\n`
      : "If you have Claude Code installed, run `claude /login` first, then re-run setup.\n") +
      "Otherwise, paste an Anthropic OAuth setup token (starts with `sk-ant-oat-`).",
    "Sign in with Claude",
  );

  const token = await p.text({
    message: "Paste your Claude setup token",
    placeholder: "sk-ant-oat-…",
    validate: (v) => {
      if (!v || !v.trim()) return "Token is required";
      if (!v.trim().startsWith("sk-ant-")) return "Expected a token starting with `sk-ant-`";
      return undefined;
    },
  });
  if (p.isCancel(token)) return "cancelled";

  try {
    loginWithSetupToken(dataDir, token as string);
    return "ok";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    p.cancel(msg);
    return "cancelled";
  }
}

async function pickModel(providerId: Provider): Promise<string | "cancelled"> {
  const presets = MODEL_PRESETS[providerId] ?? [];
  const options: { value: string; label: string; hint?: string }[] = presets.map((m) => ({
    value: m.id,
    label: m.label,
    hint: m.hint,
  }));
  options.push({
    value: CUSTOM_MODEL_ID,
    label: "Custom (enter model ID)…",
    hint: "anything from this provider",
  });

  const choice = await p.select<string>({
    message: "Pick a model",
    options,
  });
  if (p.isCancel(choice)) return "cancelled";
  if (choice !== CUSTOM_MODEL_ID) return choice;

  const custom = await p.text({
    message: "Model ID",
    placeholder: "e.g. gpt-5.5 or claude-opus-4-7",
    validate: (v) => (v && v.trim() ? undefined : "Model ID is required"),
  });
  if (p.isCancel(custom)) return "cancelled";
  return (custom as string).trim();
}

function cancel(): void {
  p.cancel("Setup cancelled.");
  process.exit(0);
}
