import type { Browser, BrowserContext, Page } from "playwright-core";
import { connectOverCdp, isRecoverableDisconnect } from "./cdp.js";
import type { AcquiredBrowser, BrowserProvider } from "./providers/base.js";
import type { AgentBrowserOverrides } from "./types.js";
import { ariaSnapshot } from "./snapshot.js";
import type {
  ActionResult,
  ClickCoordsParams,
  ClickParams,
  ConsoleEntry,
  ConsoleMessagesParams,
  ConsoleMessagesResult,
  DialogResult,
  DragParams,
  EvaluateParams,
  EvaluateResult,
  FileUploadParams,
  FillFormParams,
  FillFormResult,
  HandleDialogParams,
  HoverParams,
  NavHistoryResult,
  NavigateParams,
  NavigateResult,
  PdfResult,
  PressKeyParams,
  ResizeParams,
  ResizeResult,
  SaveAsPdfParams,
  ScreenshotParams,
  ScreenshotResult,
  SelectOptionParams,
  SelectOptionResult,
  SnapshotParams,
  SnapshotResult,
  TabId,
  TabInfo,
  TypeParams,
  WaitForParams,
} from "./types.js";

const MAX_CONSOLE_PER_PAGE = 200;

interface PerAgentTabs {
  next: number;
  /** Stable map from agent-visible tab id (t1, t2, …) to live Page. */
  byTabId: Map<TabId, Page>;
  /** Reverse — lets us resolve a page we already see to its existing alias. */
  byPage: Map<Page, TabId>;
}

interface PageState {
  console: ConsoleEntry[];
  dialogHandler: ((dialog: import("playwright-core").Dialog) => Promise<void>) | null;
}

interface AgentBrowserInstance {
  acquired: AcquiredBrowser;
  /** CDP-attached browser. Null when the provider supplied a pre-built
   *  BrowserContext (Camoufox path). */
  browser: Browser | null;
  /** The agent's working BrowserContext — either contexts[0] of `browser`
   *  or the context the provider handed us. */
  context: BrowserContext;
  agentTabs: PerAgentTabs;
  activeTabId: TabId | null;
  pageState: WeakMap<Page, PageState>;
}

/**
 * Per-agent browser orchestrator. Each agent that calls a browser tool
 * gets its own session — a separate Chrome process for the local provider,
 * a separate cloud session for Browserbase / Browser-Use / Firecrawl.
 * Sessions are lazy and acquired on first tool call.
 *
 * Why per-agent: shared cookies cascade bans across the workforce, and
 * shared fingerprints get the whole org flagged on social-media-style
 * sites. Each agent is a distinct persona; the runtime should reflect that.
 */
export class BrowserManager {
  private provider: BrowserProvider;
  private readonly resolveOverrides:
    | ((agentId: string) => AgentBrowserOverrides | undefined)
    | null;
  private readonly ensureOverrides:
    | ((
        agentId: string,
        current: AgentBrowserOverrides | undefined
      ) => Promise<AgentBrowserOverrides | undefined>)
    | null;
  private instances = new Map<string, AgentBrowserInstance>();
  private connecting = new Map<string, Promise<AgentBrowserInstance>>();

  constructor(opts: {
    provider: BrowserProvider;
    /** Look up per-agent browser overrides at acquire time. AgentManager
     *  supplies this with a closure over agentStore. Without it, providers
     *  fall back to env vars / their own defaults. */
    resolveOverrides?: (agentId: string) => AgentBrowserOverrides | undefined;
    /** Lazy-provision a per-agent profile when the agent doesn't have one
     *  yet for the active provider. Called once per first-acquire when the
     *  resolved overrides are missing the provider-specific profile field.
     *  Returns the updated overrides (which AgentManager should also
     *  persist to the agent store, so the next acquire skips this). */
    ensureOverrides?: (
      agentId: string,
      current: AgentBrowserOverrides | undefined
    ) => Promise<AgentBrowserOverrides | undefined>;
  }) {
    this.provider = opts.provider;
    this.resolveOverrides = opts.resolveOverrides ?? null;
    this.ensureOverrides = opts.ensureOverrides ?? null;
  }

  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Hot-swap the provider (config reload). Existing acquired sessions keep
   * running on their old provider until released; the next acquire uses the
   * new one. Lets browser-config changes apply without a daemon restart.
   */
  setProvider(provider: BrowserProvider): void {
    this.provider = provider;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  private async getInstance(agentId: string): Promise<AgentBrowserInstance> {
    if (!agentId) throw new Error("BrowserManager calls require an agentId");
    const existing = this.instances.get(agentId);
    if (existing && this.isInstanceAlive(existing)) return existing;
    if (existing) {
      this.instances.delete(agentId);
      try {
        await existing.acquired.release();
      } catch {
        // best-effort
      }
    }
    const inflight = this.connecting.get(agentId);
    if (inflight) return inflight;
    const p = this.connectFor(agentId).finally(() => this.connecting.delete(agentId));
    this.connecting.set(agentId, p);
    return p;
  }

  private isInstanceAlive(inst: AgentBrowserInstance): boolean {
    // CDP path: rely on the underlying Browser's connection state.
    // Pre-built context path: by construction, the provider/manager's
    // close listener already drops the entry.
    if (inst.browser) return inst.browser.isConnected();
    return true;
  }

  private async connectFor(agentId: string): Promise<AgentBrowserInstance> {
    let overrides = this.resolveOverrides?.(agentId);
    // Lazy provisioning: if the agent doesn't have a profile yet for the
    // active provider, give AgentManager a chance to create one now and
    // persist it back. First-acquire pays the provision cost; subsequent
    // acquires skip this because the agent def now has the field.
    if (this.ensureOverrides) {
      try {
        overrides = await this.ensureOverrides(agentId, overrides);
      } catch {
        // best-effort — fall through with whatever we had
      }
    }
    const acquired = await this.provider.acquire(agentId, { overrides });
    let browser: Browser | null = null;
    let context: BrowserContext;
    try {
      if (acquired.preBuiltContext) {
        context = acquired.preBuiltContext;
      } else if (acquired.cdpUrl) {
        browser = await connectOverCdp({
          wsUrl: acquired.cdpUrl,
          onDisconnected: (b) => {
            const inst = this.instances.get(agentId);
            if (inst && inst.browser === b) this.instances.delete(agentId);
          },
        });
        const ctxs = browser.contexts();
        if (ctxs.length === 0) throw new Error("CDP browser has no contexts");
        context = ctxs[0]!;
      } else {
        throw new Error("Provider returned neither cdpUrl nor preBuiltContext");
      }
    } catch (e) {
      // Avoid leaking the upstream session when the initial attach fails.
      try {
        await acquired.release();
      } catch {
        // best-effort
      }
      throw e;
    }
    const instance: AgentBrowserInstance = {
      acquired,
      browser,
      context,
      agentTabs: { next: 1, byTabId: new Map(), byPage: new Map() },
      activeTabId: null,
      pageState: new WeakMap(),
    };
    // For pre-built contexts, mirror what the CDP `disconnected` listener
    // does — drop the cache when the context closes.
    if (!browser) {
      context.once("close", () => {
        if (this.instances.get(agentId) === instance) this.instances.delete(agentId);
      });
    }
    this.instances.set(agentId, instance);
    return instance;
  }

  private async contextFor(agentId: string): Promise<{ inst: AgentBrowserInstance; ctx: BrowserContext }> {
    const inst = await this.getInstance(agentId);
    return { inst, ctx: inst.context };
  }

  /** Release one agent's browser session. Idempotent. */
  async closeAgent(agentId: string): Promise<void> {
    const inst = this.instances.get(agentId);
    if (inst) {
      this.instances.delete(agentId);
      try {
        if (inst.browser) await inst.browser.close();
        // Pre-built context lifetime is owned by the provider; releaseAgent
        // below closes it.
      } catch {
        // best-effort
      }
    }
    try {
      await this.provider.releaseAgent(agentId);
    } catch {
      // best-effort
    }
  }

  /** Release every agent and shut down the provider. */
  async close(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    await Promise.all(ids.map((id) => this.closeAgent(id)));
    try {
      await this.provider.releaseAll();
    } catch {
      // best-effort
    }
  }

  // ───────────────────────── per-page observation ─────────────────────────

  private observePage(inst: AgentBrowserInstance, page: Page): void {
    if (inst.pageState.has(page)) return;
    const state: PageState = { console: [], dialogHandler: null };
    inst.pageState.set(page, state);
    page.on("console", (msg) => {
      if (state.console.length >= MAX_CONSOLE_PER_PAGE) state.console.shift();
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("pageerror", (err) => {
      if (state.console.length >= MAX_CONSOLE_PER_PAGE) state.console.shift();
      state.console.push({
        type: "error",
        text: err.message,
        timestamp: new Date().toISOString(),
      });
    });
  }

  // ───────────────────────── tab tracking ─────────────────────────

  /**
   * Tab identity is the Page object itself — stable for the page's
   * lifetime in Playwright. Avoids CDP-specific calls (`newCDPSession`)
   * so Firefox-based backends (Camoufox) work the same as Chromium.
   */
  private trackPage(inst: AgentBrowserInstance, page: Page): TabId {
    const existing = inst.agentTabs.byPage.get(page);
    if (existing) {
      this.observePage(inst, page);
      inst.activeTabId = existing;
      return existing;
    }
    this.observePage(inst, page);
    const tabId: TabId = `t${inst.agentTabs.next}`;
    inst.agentTabs.next += 1;
    inst.agentTabs.byTabId.set(tabId, page);
    inst.agentTabs.byPage.set(page, tabId);
    inst.activeTabId = tabId;
    page.once("close", () => {
      inst.agentTabs.byTabId.delete(tabId);
      inst.agentTabs.byPage.delete(page);
      if (inst.activeTabId === tabId) inst.activeTabId = null;
    });
    return tabId;
  }

  private async resolvePage(
    agentId: string,
    tabId: TabId | undefined,
    opts: { createIfNone: boolean }
  ): Promise<{ inst: AgentBrowserInstance; page: Page; tabId: TabId }> {
    const { inst, ctx } = await this.contextFor(agentId);
    let page: Page | null = null;
    let resolvedTabId: TabId | null = null;

    if (tabId) {
      const candidate = inst.agentTabs.byTabId.get(tabId);
      if (!candidate) throw new Error(`Tab ${tabId} not found for this agent.`);
      if (candidate.isClosed()) {
        inst.agentTabs.byTabId.delete(tabId);
        inst.agentTabs.byPage.delete(candidate);
        if (inst.activeTabId === tabId) inst.activeTabId = null;
        throw new Error(`Tab ${tabId} is no longer open.`);
      }
      page = candidate;
      resolvedTabId = tabId;
    } else if (inst.activeTabId) {
      const candidate = inst.agentTabs.byTabId.get(inst.activeTabId);
      if (candidate && !candidate.isClosed()) {
        page = candidate;
        resolvedTabId = inst.activeTabId;
      } else {
        if (candidate) {
          inst.agentTabs.byTabId.delete(inst.activeTabId);
          inst.agentTabs.byPage.delete(candidate);
        }
        inst.activeTabId = null;
      }
    }

    if (!page) {
      if (!opts.createIfNone) {
        throw new Error("No tabs open for this agent. Call browser_navigate first to open one.");
      }
      page = await ctx.newPage();
      resolvedTabId = this.trackPage(inst, page);
    }

    this.observePage(inst, page);
    return { inst, page, tabId: resolvedTabId! };
  }

  /**
   * Run an action with one-shot reconnect on transient CDP disconnects.
   * Drops the agent's instance + cloud session before retrying so we
   * don't reuse a server-side session that the provider already killed.
   */
  private async withReconnect<T>(
    agentId: string,
    tabId: TabId | undefined,
    opts: { createIfNone: boolean },
    fn: (page: Page, ids: { tabId: TabId }) => Promise<T>
  ): Promise<T> {
    try {
      const r = await this.resolvePage(agentId, tabId, opts);
      return await fn(r.page, { tabId: r.tabId });
    } catch (e) {
      if (!isRecoverableDisconnect(e)) throw e;
      await this.closeAgent(agentId);
      const r = await this.resolvePage(agentId, tabId, opts);
      return await fn(r.page, { tabId: r.tabId });
    }
  }

  // ───────────────────────── public API ─────────────────────────

  async navigate(agentId: string, p: NavigateParams): Promise<NavigateResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: true }, async (page, ids) => {
      await page.goto(p.url, { waitUntil: "domcontentloaded" });
      const [title, url, snapshot] = await Promise.all([
        page.title(),
        Promise.resolve(page.url()),
        ariaSnapshot(page),
      ]);
      return { tabId: ids.tabId, url, title, snapshot };
    });
  }

  async snapshot(agentId: string, p: SnapshotParams): Promise<SnapshotResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const snapshot = await ariaSnapshot(page, p.selector);
      return { tabId: ids.tabId, url: page.url(), snapshot };
    });
  }

  async click(agentId: string, p: ClickParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.locator(p.ref).click();
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }

  async type(agentId: string, p: TypeParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const loc = page.locator(p.ref);
      await loc.fill(p.text);
      if (p.submit) await loc.press("Enter");
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }

  async pressKey(agentId: string, p: PressKeyParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.keyboard.press(p.key);
      // Only Enter triggers a post-action snapshot — matches Microsoft's
      // playwright-mcp; other keys (Escape, ArrowDown, ...) don't change
      // the DOM in a way the model needs to re-see.
      const result: ActionResult = { tabId: ids.tabId };
      if (p.key === "Enter") result.snapshot = await ariaSnapshot(page);
      return result;
    });
  }

  async takeScreenshot(agentId: string, p: ScreenshotParams): Promise<ScreenshotResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const buf = await page.screenshot({ fullPage: !!p.fullPage, type: "png" });
      return {
        tabId: ids.tabId,
        pngBase64: buf.toString("base64"),
        mediaType: "image/png",
      };
    });
  }

  async waitFor(agentId: string, p: WaitForParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      if (p.text) {
        await page.getByText(p.text, { exact: false }).first().waitFor({ timeout: 30_000 });
      } else if (p.textGone) {
        await page
          .getByText(p.textGone, { exact: false })
          .first()
          .waitFor({ state: "hidden", timeout: 30_000 });
      } else if (p.timeMs && p.timeMs > 0) {
        await page.waitForTimeout(p.timeMs);
      }
      return { tabId: ids.tabId };
    });
  }

  async evaluate(agentId: string, p: EvaluateParams): Promise<EvaluateResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      // Playwright's page.evaluate(string) treats the source as an
      // expression. Passing `() => 42` therefore evaluates to the function
      // value (non-serializable → undefined → masked to null below), not
      // 42. Wrap in an IIFE that invokes when the result is callable so
      // arrow / function expressions actually run, while plain expressions
      // pass through unchanged. `await` covers async functions.
      const src = `(async () => { const __r = (${p.function}); return typeof __r === 'function' ? await __r() : __r; })()`;
      const raw = await page.evaluate(src);
      // JSON.stringify drops keys whose value is undefined, so the agent
      // sees no `result` field and thinks the call silently failed.
      return { tabId: ids.tabId, result: raw === undefined ? null : raw };
    });
  }

  async consoleMessages(
    agentId: string,
    p: ConsoleMessagesParams
  ): Promise<ConsoleMessagesResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const { inst } = await this.contextFor(agentId);
      const state = inst.pageState.get(page);
      const messages = state ? [...state.console] : [];
      if (p.clear && state) state.console = [];
      return { tabId: ids.tabId, messages };
    });
  }

  // ── tabs ──

  async tabsList(agentId: string): Promise<TabInfo[]> {
    const { inst } = await this.contextFor(agentId);
    const out: TabInfo[] = [];
    for (const [tabId, page] of inst.agentTabs.byTabId) {
      if (page.isClosed()) continue;
      out.push({
        tabId,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: tabId === inst.activeTabId,
      });
    }
    out.sort((a, b) => {
      const na = Number.parseInt(a.tabId.slice(1), 10);
      const nb = Number.parseInt(b.tabId.slice(1), 10);
      return na - nb;
    });
    return out;
  }

  async tabsNew(agentId: string, p: { url?: string }): Promise<TabInfo> {
    const { inst, ctx } = await this.contextFor(agentId);
    const page = await ctx.newPage();
    if (p.url) await page.goto(p.url, { waitUntil: "domcontentloaded" });
    const tabId = this.trackPage(inst, page);
    return {
      tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: true,
    };
  }

  async tabsClose(agentId: string, p: { tabId: TabId }): Promise<void> {
    const { inst } = await this.contextFor(agentId);
    const page = inst.agentTabs.byTabId.get(p.tabId);
    if (!page) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    if (!page.isClosed()) {
      // page.close() fires the trackPage close handler which drops the maps.
      await page.close();
    } else {
      inst.agentTabs.byTabId.delete(p.tabId);
      inst.agentTabs.byPage.delete(page);
      if (inst.activeTabId === p.tabId) inst.activeTabId = null;
    }
  }

  async tabsSelect(agentId: string, p: { tabId: TabId }): Promise<TabInfo> {
    const { inst } = await this.contextFor(agentId);
    const page = inst.agentTabs.byTabId.get(p.tabId);
    if (!page) throw new Error(`Tab ${p.tabId} not found for this agent.`);
    if (page.isClosed()) {
      inst.agentTabs.byTabId.delete(p.tabId);
      inst.agentTabs.byPage.delete(page);
      if (inst.activeTabId === p.tabId) inst.activeTabId = null;
      throw new Error(`Tab ${p.tabId} is no longer open.`);
    }
    inst.activeTabId = p.tabId;
    await page.bringToFront().catch(() => {});
    return {
      tabId: p.tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: true,
    };
  }

  // ── consolidated `act` verbs ──

  async hover(agentId: string, p: HoverParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.locator(p.ref).hover();
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }

  async drag(agentId: string, p: DragParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.locator(p.startRef).dragTo(page.locator(p.endRef));
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }

  async selectOption(agentId: string, p: SelectOptionParams): Promise<SelectOptionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const selected = await page.locator(p.ref).selectOption(p.values);
      return { tabId: ids.tabId, selected, snapshot: await ariaSnapshot(page) };
    });
  }

  async fillForm(agentId: string, p: FillFormParams): Promise<FillFormResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      for (const f of p.fields) {
        await page.locator(f.ref).fill(f.value);
      }
      return {
        tabId: ids.tabId,
        filled: p.fields.length,
        snapshot: await ariaSnapshot(page),
      };
    });
  }

  async fileUpload(agentId: string, p: FileUploadParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.locator(p.ref).setInputFiles(p.paths);
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }

  async handleDialog(agentId: string, p: HandleDialogParams): Promise<DialogResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          page.off("dialog", onDialog);
          reject(new Error("Timed out waiting for a dialog"));
        }, 30_000);
        const onDialog = async (dialog: import("playwright-core").Dialog) => {
          clearTimeout(timer);
          try {
            if (p.accept) {
              await dialog.accept(p.promptText ?? undefined);
            } else {
              await dialog.dismiss();
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        page.once("dialog", onDialog);
      });
      return { tabId: ids.tabId, result: p.accept ? "accepted" : "dismissed" };
    });
  }

  async resize(agentId: string, p: ResizeParams): Promise<ResizeResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.setViewportSize({ width: p.width, height: p.height });
      return { tabId: ids.tabId, width: p.width, height: p.height };
    });
  }

  async navigateBack(agentId: string, p: { tabId?: TabId }): Promise<NavHistoryResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.goBack({ waitUntil: "domcontentloaded" });
      return {
        tabId: ids.tabId,
        url: page.url(),
        snapshot: await ariaSnapshot(page),
      };
    });
  }

  async navigateForward(agentId: string, p: { tabId?: TabId }): Promise<NavHistoryResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.goForward({ waitUntil: "domcontentloaded" });
      return {
        tabId: ids.tabId,
        url: page.url(),
        snapshot: await ariaSnapshot(page),
      };
    });
  }

  async saveAsPdf(agentId: string, p: SaveAsPdfParams): Promise<PdfResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      const filename = p.filename ?? `browser-${ids.tabId}-${Date.now()}.pdf`;
      const outPath = filename.includes("/") ? filename : `/tmp/${filename}`;
      await page.pdf({ path: outPath, format: "Letter" });
      return { tabId: ids.tabId, path: outPath };
    });
  }

  async clickCoords(agentId: string, p: ClickCoordsParams): Promise<ActionResult> {
    return this.withReconnect(agentId, p.tabId, { createIfNone: false }, async (page, ids) => {
      await page.mouse.click(p.x, p.y);
      return { tabId: ids.tabId, snapshot: await ariaSnapshot(page) };
    });
  }
}
