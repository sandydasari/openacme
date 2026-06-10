import * as p from "@clack/prompts";
import gradient from "gradient-string";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveDataDir,
  readRawConfig,
  writeRawConfig,
  createAgentStore,
  type Provider,
  type AuthMode,
  type AgentDefinition,
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

const DEFAULT_PERSONA =
  "You are a helpful AI assistant. You can execute shell commands, read and write files, and search the filesystem to help users with their tasks.";
const DEFAULT_TOOLS = [
  "shell",
  "read_file",
  "write_file",
  "list_files",
  "search_files",
  "memory",
];
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Interactive setup wizard.
 *
 * On a fresh install: walks through provider → auth → model and creates
 * the first agent. On a re-run with existing agents, asks whether you want
 * to add another agent (and lets you skip auth by reusing an existing
 * provider's config) or configure a new provider end-to-end.
 */
export async function setupCommand(opts: { dataDir?: string }) {
  const dataDir = resolveDataDir(opts.dataDir);

  console.log();
  const coolGradient = gradient(["#0ea5e9", "#7dd3fc", "#ffffff"]);
  p.intro(coolGradient("OpenAcme Setup"));

  p.note(`Data directory: ${dataDir}`, "Configuration");

  const agentsDir = path.join(dataDir, "agents");
  const agentStore = createAgentStore(agentsDir);
  const existingAgents = agentStore.list();

  if (existingAgents.length === 0) {
    // First-run: bundle provider config with agent creation so the user has
    // a working setup at the end. The two are still distinct steps inside.
    return await configureProviderAndCreateAgent(
      dataDir,
      agentStore,
      [],
      { withAgent: true }
    );
  }

  // Existing install — branch on intent.
  const intent = await p.select<"reuse" | "configure" | "cancel">({
    message: `You already have ${existingAgents.length} agent${existingAgents.length === 1 ? "" : "s"} configured. What do you want to do?`,
    options: [
      { value: "reuse", label: "Add a new agent" },
      { value: "configure", label: "Configure a new provider" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(intent) || intent === "cancel") return cancel();

  if (intent === "reuse") {
    return await addAgentReusingProvider(agentsDir, agentStore, existingAgents);
  }
  return await configureProviderAndCreateAgent(
    dataDir,
    agentStore,
    existingAgents,
    { withAgent: false }
  );
}

/**
 * Add an agent that reuses one of the provider configs already in use by
 * an existing agent. Skips auth entirely — the existing OAuth tokens or
 * API key in `.env` already cover the new agent.
 */
async function addAgentReusingProvider(
  agentsDir: string,
  agentStore: ReturnType<typeof createAgentStore>,
  existingAgents: AgentDefinition[]
): Promise<void> {
  // 1. Collect unique provider configs from existing agents that set
  // `model` explicitly (agents without it inherit the root config —
  // nothing per-agent to reuse). Two agents sharing the same
  // (provider, auth, baseUrl) tuple appear once.
  const seen = new Set<string>();
  const reusable: Array<{
    key: string;
    label: string;
    hint: string;
    config: NonNullable<AgentDefinition["model"]>;
  }> = [];
  for (const a of existingAgents) {
    const m = a.model;
    if (!m) continue;
    const key = `${m.provider}:${m.auth ?? "api_key"}:${m.baseUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reusable.push({
      key,
      label: `${m.provider} (${m.auth === "oauth" ? "OAuth" : "API key"})`,
      hint: `from ${a.id}`,
      config: m,
    });
  }

  const choice = await p.select<string>({
    message: "Which provider config do you want to reuse?",
    options: reusable.map((r) => ({
      value: r.key,
      label: r.label,
      hint: r.hint,
    })),
  });
  if (p.isCancel(choice)) return cancel();
  const baseConfig = reusable.find((r) => r.key === choice)!.config;

  // 2. Pick a model for that provider.
  const modelId = await pickModel(baseConfig.provider as Provider);
  if (modelId === "cancelled") return cancel();

  // 3. Pick a unique agent id.
  const taken = new Set(existingAgents.map((a) => a.id));
  const id = await p.text({
    message: "Agent id",
    placeholder: "code-reviewer",
    validate: (v) => {
      const trimmed = (v ?? "").trim();
      if (!trimmed) return "Required";
      if (!SAFE_AGENT_ID.test(trimmed))
        return "Use letters, digits, _ . - (no leading dot or slashes)";
      if (trimmed === "acme")
        return 'id "acme" is reserved for the platform agent';
      if (taken.has(trimmed)) return `id "${trimmed}" is already taken`;
      return undefined;
    },
  });
  if (p.isCancel(id)) return cancel();
  const agentId = (id as string).trim();

  // 4. Display name.
  const defaultName = titleCase(agentId);
  const name = await p.text({
    message: "Agent name",
    placeholder: defaultName,
    initialValue: defaultName,
    validate: (v) => ((v ?? "").trim() ? undefined : "Required"),
  });
  if (p.isCancel(name)) return cancel();

  // 5. Save the new agent file.
  const spin = p.spinner();
  spin.start("Saving agent");
  const newAgent: AgentDefinition = {
    id: agentId,
    name: (name as string).trim(),
    role: "",
    model: { ...baseConfig, model: modelId },
    persona: DEFAULT_PERSONA,
    tools: DEFAULT_TOOLS,
    mcpServers: {},
    mcpDisabled: [],
    skills: [],
    probeIntervalMs: 30 * 60 * 1000,
    paths: [],
  };
  try {
    agentStore.upsert(newAgent);
  } catch (e) {
    spin.stop("Save failed");
    p.cancel(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  spin.stop(`Added agent: ${agentId}`);

  p.note(
    [
      `Agent id: ${agentId}`,
      `Provider: ${baseConfig.provider} (${baseConfig.auth === "oauth" ? "OAuth" : "API key"})`,
      `Model: ${modelId}`,
      `Agent file: ${path.join(agentsDir, agentId, "AGENT.md")}`,
    ].join("\n"),
    "Summary"
  );

  p.outro("Done. Re-run `openacme start` if the server is already running.");
}

/**
 * The original setup flow — pick provider, run auth (OAuth or API key),
 * pick a model, and create or update the first agent. When existing
 * agents are present the user is prompted to choose between updating the
 * default agent in place or adding a new one alongside.
 */
async function configureProviderAndCreateAgent(
  dataDir: string,
  agentStore: ReturnType<typeof createAgentStore>,
  existingAgents: AgentDefinition[],
  opts: { withAgent: boolean } = { withAgent: true }
): Promise<void> {
  const agentsDir = path.join(dataDir, "agents");

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

  // Provider-only flow: stop here. The agent-creation step is a separate
  // concern (different menu choice). Tell the user how to take the next
  // step explicitly rather than bundling it implicitly.
  if (!opts.withAgent) {
    const summaryLines = [
      `Provider: ${provider.name}`,
      `Auth: ${auth.mode === "oauth" ? "OAuth subscription" : "API key"}`,
    ];
    if (auth.mode === "oauth")
      summaryLines.push(`Tokens: ${path.join(dataDir, "auth.json")}`);
    if (auth.mode === "api_key" && provider.envVar)
      summaryLines.push(`API key: ${path.join(dataDir, ".env")}`);
    p.note(summaryLines.join("\n"), "Provider configured");
    p.outro(
      `Run \`openacme setup\` again and pick "Add a new agent" to create one that uses ${provider.name}.`
    );
    return;
  }

  // 3. Model — auto-pick the recommended default for this provider on
  // first run; user can change later via the web UI's model picker or by
  // editing config.yaml. `custom` is the one case where there's no
  // sensible default — fall back to the interactive picker.
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

  // 4. Replace-vs-add when an agent with a different provider exists.
  const firstAgent = existingAgents[0];
  const existingProvider = firstAgent?.model?.provider;
  let mode: "replace" | "add" = "replace";
  if (firstAgent && existingProvider && existingProvider !== provider.id) {
    const existingName = firstAgent.name || firstAgent.id;
    const choice = await p.select<"replace" | "add">({
      message: `You already have an agent "${existingName}" using ${existingProvider}. What do you want to do?`,
      options: [
        {
          value: "add",
          label: `Add a new agent for ${provider.name}`,
          hint: "keeps your existing default untouched",
        },
        {
          value: "replace",
          label: `Update the default agent to use ${provider.name}`,
          hint: `replaces ${existingProvider} on the default agent`,
        },
      ],
    });
    if (p.isCancel(choice)) return cancel();
    mode = choice;
  }

  // 5. Save
  const spin = p.spinner();
  spin.start("Saving configuration");

  // First-run flag: no existing agents AND nothing got replaced. In that
  // case the wizard only records the provider + top-level model in
  // config.yaml; agent creation is the daemon's job — AgentManager
  // materializes the Acme platform agent on first boot.
  const isFirstRun = !firstAgent;

  let savedAgent: AgentDefinition | null = null;
  let savedAction: string;

  if (mode === "add") {
    const taken = new Set(existingAgents.map((a) => a.id));
    // Reserve `acme` so a user-added agent can't shadow the platform
    // agent (which materializes on first boot).
    taken.add("acme");
    let newId: string = provider.id;
    let suffix = 2;
    while (taken.has(newId)) {
      newId = `${provider.id}-${suffix}`;
      suffix++;
    }
    savedAgent = {
      id: newId,
      name: `${provider.name} Agent`,
      role: "",
      model: modelConfig,
      persona: DEFAULT_PERSONA,
      tools: DEFAULT_TOOLS,
      mcpServers: {},
      mcpDisabled: [],
      skills: [],
      probeIntervalMs: 30 * 60 * 1000,
      paths: [],
    };
    savedAction = `Added agent: ${newId}`;
  } else if (firstAgent) {
    savedAgent = { ...firstAgent, model: modelConfig };
    savedAction = `Updated agent: ${firstAgent.id}`;
  } else {
    // First run: don't create an agent. The daemon's
    // `ensureManagedAgents()` will import the Acme platform agent on
    // first boot, inheriting the model we're about to write to config.yaml.
    savedAction = "Configured provider";
  }

  try {
    if (savedAgent) {
      agentStore.upsert(savedAgent);
    }

    // Update config.yaml's top-level `model` (platform default for newly-
    // created agents, including the auto-imported Acme) and strip the
    // legacy `agents:` block if present.
    const existingConfig = readRawConfig(dataDir);
    const merged: Record<string, unknown> = {
      ...existingConfig,
      model:
        mode === "replace" || isFirstRun
          ? modelConfig
          : (existingConfig.model ?? modelConfig),
    };
    delete merged.agents;
    writeRawConfig(dataDir, merged);
  } catch (e) {
    // Without this, an exception inside upsert (e.g. YAML serializer
    // choking on undefined values) leaves the spinner running forever and
    // the user sees "something went wrong" with no explanation.
    spin.stop("Save failed");
    p.cancel(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  spin.stop(`${savedAction}.`);

  const summaryLines = [
    `Provider: ${provider.name}`,
    `Model: ${modelId}`,
    `Auth: ${auth.mode === "oauth" ? "OAuth subscription" : "API key"}`,
  ];
  if (savedAgent) {
    summaryLines.push(`Agent id: ${savedAgent.id}`);
    summaryLines.push(`Agent file: ${path.join(agentsDir, savedAgent.id, "AGENT.md")}`);
  }
  summaryLines.push(`Config: ${path.join(dataDir, "config.yaml")}`);
  if (auth.mode === "oauth") summaryLines.push(`Tokens: ${path.join(dataDir, "auth.json")}`);
  if (auth.mode === "api_key" && provider.envVar) summaryLines.push(`API key: ${path.join(dataDir, ".env")}`);
  summaryLines.push(`MCP servers: ${path.join(dataDir, "mcp.json")} — paste any Claude Desktop / Cursor config to add`);
  p.note(summaryLines.join("\n"), "Summary");

  p.outro(
    isFirstRun
      ? "Setup complete! Run `openacme start` — Acme, your platform helper, will be ready in the agent picker."
      : "Setup complete! Run: openacme start"
  );
}

function titleCase(s: string): string {
  return s
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
  const fromCC = loginWithClaudeCodeCredentials(dataDir);
  if (fromCC) {
    spin.stop("Imported Claude Code credentials.");
    return "ok";
  }
  spin.stop("Claude Code not found.");

  p.note(
    "If you have Claude Code installed, run `claude /login` first, then re-run setup.\n" +
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
