import * as p from "@clack/prompts";
import { resolveDataDir } from "@openacme/config";
import {
  oauthLoginOpenAI,
  loginWithClaudeCodeCredentials,
  loginWithSetupToken,
  looksHeadless,
} from "@openacme/auth";

export interface LoginOptions {
  provider?: "openai" | "anthropic";
  device?: boolean;
  dataDir?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  let provider = opts.provider;
  if (!provider) {
    const choice = await p.select({
      message: "Sign in to which provider?",
      options: [
        { value: "openai", label: "OpenAI (Sign in with ChatGPT)", hint: "use your ChatGPT subscription" },
        { value: "anthropic", label: "Anthropic (Sign in with Claude)", hint: "use your Claude subscription" },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Login cancelled.");
      return;
    }
    provider = choice as "openai" | "anthropic";
  }

  if (provider === "openai") {
    await loginOpenAI(dataDir, opts.device ?? false);
  } else {
    await loginAnthropic(dataDir);
  }
}

async function loginOpenAI(dataDir: string, deviceFlag: boolean): Promise<void> {
  const useDevice = deviceFlag || looksHeadless();
  const flow = useDevice ? "device" : "browser";

  if (flow === "browser") {
    p.note("Opening your browser to sign in with ChatGPT…", "OpenAI");
  }

  const spin = p.spinner();
  spin.start(flow === "browser" ? "Waiting for browser sign-in" : "Requesting device code");

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
    spin.stop(
      `Signed in${result.email ? ` as ${result.email}` : ""} via ${result.flow} flow.`,
    );
    p.outro("OpenAI OAuth complete. Run `openacme chat` to start using ChatGPT subscription quota.");
  } catch (e) {
    spin.stop("Login failed");
    const msg = e instanceof Error ? e.message : String(e);
    p.cancel(msg);
    process.exitCode = 1;
  }
}

async function loginAnthropic(dataDir: string): Promise<void> {
  const spin = p.spinner();
  spin.start("Looking for Claude Code credentials");
  let importError: string | undefined;
  const fromCC = await loginWithClaudeCodeCredentials(dataDir).catch((e) => {
    importError = e instanceof Error ? e.message : String(e);
    return null;
  });
  if (fromCC) {
    spin.stop("Imported Claude Code credentials.");
    p.outro("Anthropic OAuth complete. Run `openacme chat` to start using Claude subscription quota.");
    return;
  }
  spin.stop(importError ? "Claude Code credentials unusable." : "Claude Code not found.");

  p.note(
    (importError
      ? `${importError}\n`
      : "We couldn't find Claude Code credentials.\n" +
        "If you have Claude Code installed, run `claude /login` first, then re-run this command.\n") +
      "Otherwise, paste an Anthropic OAuth setup token (starts with `sk-ant-oat-`).",
    "Sign in with Claude",
  );

  const token = await p.text({
    message: "Paste your Claude setup token (or press Esc to cancel)",
    placeholder: "sk-ant-oat-…",
    validate: (value) => {
      if (!value || !value.trim()) return "Token is required";
      if (!value.trim().startsWith("sk-ant-")) return "Expected a token starting with `sk-ant-`";
      return undefined;
    },
  });
  if (p.isCancel(token)) {
    p.cancel("Login cancelled.");
    return;
  }

  try {
    loginWithSetupToken(dataDir, token as string);
    p.outro("Anthropic OAuth complete. Run `openacme chat` to start using Claude subscription quota.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    p.cancel(msg);
    process.exitCode = 1;
  }
}
