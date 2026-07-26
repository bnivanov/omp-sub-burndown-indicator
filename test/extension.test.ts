import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import subscriptionBurndownExtension from "../src/index.ts";
import { type IndicatorController, WIDGET_KEY } from "../src/runtime/controller.ts";

type Handler = (
  event: { type: string; headers?: Record<string, string>; status?: number },
  ctx: ExtensionContext,
) => Promise<void> | void;

function fakeContext(hasUI: boolean) {
  const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
  const notifications: string[] = [];
  const notificationLevels: string[] = [];
  const model = { provider: "anthropic", id: "claude" };
  const ctx = {
    cwd: process.cwd(),
    hasUI,
    model,
    models: {
      list: () => [model],
      current: () => model,
      resolve: () => undefined,
      family: () => "claude",
    },
    ui: {
      setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
        widgets.push({
          key,
          content,
          ...(options?.placement ? { placement: options.placement } : {}),
        });
      },
      notify: (message: string, level?: string) => {
        notifications.push(message);
        notificationLevels.push(level ?? "info");
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets, notifications, notificationLevels };
}

test("default factory registers lifecycle, commands, and plugin-runtime persistence", async () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<
    string,
    {
      name: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
    }
  >();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      },
    ) => {
      commands.set(name, { name, ...options });
    },
  } as unknown as ExtensionAPI;
  const settings: Record<string, unknown> = {};
  const persisted: Array<[string, string | number]> = [];
  subscriptionBurndownExtension(api, {
    readPluginSettings: async () => settings,
    persistPluginSetting: async (_cwd, setting, value) => {
      persisted.push([setting, value]);
      settings[setting] = value;
    },
  });
  expect([...handlers.keys()].sort()).toEqual([
    "after_provider_response",
    "session_shutdown",
    "session_start",
    "session_switch",
    "session_tree",
  ]);
  expect([...commands.keys()]).toEqual(["burndown"]);

  const interactive = fakeContext(true);
  await handlers.get("session_start")?.({ type: "session_start" }, interactive.ctx);
  const installed = interactive.widgets.find((entry) => entry.content !== undefined);
  expect(installed?.key).toBe(WIDGET_KEY);
  expect(installed?.placement).toBe("aboveEditor");
  expect(typeof installed?.content).toBe("function");

  await commands.get("burndown")?.handler("", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Burndown status");
  expect(interactive.notifications[0]).toContain("windowView:");

  await commands.get("burndown")?.handler("view week", interactive.ctx);
  expect(interactive.notifications.at(-1)).toContain("Burndown view: week");
  expect(persisted).toEqual([["windowView", "week"]]);

  await commands.get("burndown")?.handler("labels masked", interactive.ctx);
  await commands.get("burndown")?.handler("provider truncate 8", interactive.ctx);
  await commands.get("burndown")?.handler("exhausted label symbol", interactive.ctx);
  expect(persisted).toEqual([
    ["windowView", "week"],
    ["accountLabels", "masked"],
    ["providerLabelMaxColumns", 8],
    ["exhaustedLabel", "symbol"],
  ]);

  const completions = commands.get("burndown")?.getArgumentCompletions;
  expect(completions?.("view ")).toEqual([
    { value: "view hour", label: "view hour" },
    { value: "view week", label: "view week" },
    { value: "view month", label: "view month" },
    { value: "view all", label: "view all" },
  ]);
  expect(completions?.("zz")).toBeNull();

  await commands.get("burndown")?.handler("labels hidden", interactive.ctx);
  expect(interactive.notifications.at(-1)).toContain("Usage: /burndown");

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, interactive.ctx);
  expect(interactive.widgets.at(-1)?.content).toBeUndefined();
});

test("persistence failures keep view and display changes active for the session", async () => {
  const handlers = new Map<string, Handler>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const restarts: Array<Readonly<Record<string, unknown>> | undefined> = [];
  let windowView = "five_hour";
  const controller = {
    start: async () => undefined,
    restart: async (_ctx: ExtensionContext, settings?: Readonly<Record<string, unknown>>) => {
      restarts.push(settings);
      if (settings?.windowView) windowView = String(settings.windowView);
    },
    shutdown: () => undefined,
    ingestResponse: () => undefined,
    status: () => `windowView: ${windowView}`,
    applyWindowViewCommand: (args: string) => {
      if (args === "week") {
        windowView = "week";
        return { mode: "week" as const, changed: true, detail: "Burndown view: week" };
      }
      return { mode: "five_hour" as const, changed: false, detail: "Burndown view: five_hour" };
    },
  } as unknown as IndicatorController;
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => commands.set(name, options),
  } as unknown as ExtensionAPI;
  const interactive = fakeContext(true);
  subscriptionBurndownExtension(api, {
    controller,
    readPluginSettings: async () => ({ layout: "fit", windowView: "five_hour" }),
    persistPluginSetting: async () => {
      throw new Error("settings directory unavailable");
    },
  });

  await commands.get("burndown")?.handler("view week", interactive.ctx);
  expect(windowView).toBe("week");
  expect(interactive.notifications.at(-1)).toBe(
    "Burndown view changed for this session only; unable to persist setting.",
  );
  expect(interactive.notificationLevels.at(-1)).toBe("warning");

  await commands.get("burndown")?.handler("layout wrap", interactive.ctx);
  expect(restarts.at(-1)).toEqual({ layout: "wrap", windowView: "five_hour" });
  expect(interactive.notifications.at(-1)).toBe(
    "Burndown display updated for this session only; unable to persist setting.",
  );
  expect(interactive.notificationLevels.at(-1)).toBe("warning");
});

test("headless and component-stubbing hosts degrade without throwing", async () => {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  subscriptionBurndownExtension(api, {
    readPluginSettings: async () => ({}),
    persistPluginSetting: async () => undefined,
  });

  const headless = fakeContext(false);
  await handlers.get("session_start")?.({ type: "session_start" }, headless.ctx);
  expect(headless.widgets).toEqual([]);

  const stub = fakeContext(true);
  stub.ctx.ui.setWidget = () => {
    throw new Error("component factories unsupported");
  };
  await expect(
    handlers.get("session_switch")?.({ type: "session_switch" }, stub.ctx),
  ).resolves.toBeUndefined();
  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, stub.ctx);
});
