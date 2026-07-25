import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import subscriptionBurndownExtension from "../src/index.ts";
import { WIDGET_KEY } from "../src/runtime/controller.ts";

type Handler = (
  event: { type: string; headers?: Record<string, string>; status?: number },
  ctx: ExtensionContext,
) => Promise<void> | void;

function fakeContext(hasUI: boolean) {
  const widgets: Array<{ key: string; content: unknown; placement?: string }> = [];
  const notifications: string[] = [];
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
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets, notifications };
}

test("default factory registers public lifecycle, response, and diagnostic contracts", async () => {
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
  const persisted: string[] = [];
  subscriptionBurndownExtension(api, {
    readPluginSettings: async () => ({}),
    persistWindowView: async (_cwd, mode) => {
      persisted.push(mode);
    },
  });
  expect([...handlers.keys()].sort()).toEqual([
    "after_provider_response",
    "session_shutdown",
    "session_start",
    "session_switch",
    "session_tree",
  ]);
  expect([...commands.keys()].sort()).toEqual(["burndown-status", "burndown-view"]);

  const interactive = fakeContext(true);
  await handlers.get("session_start")?.({ type: "session_start" }, interactive.ctx);
  const installed = interactive.widgets.find((entry) => entry.content !== undefined);
  expect(installed?.key).toBe(WIDGET_KEY);
  expect(installed?.placement).toBe("aboveEditor");
  expect(typeof installed?.content).toBe("function");

  await commands.get("burndown-status")?.handler("", interactive.ctx);
  expect(interactive.notifications[0]).toContain("Burndown status");
  expect(interactive.notifications[0]).toContain("windowView:");

  await commands.get("burndown-view")?.handler("week", interactive.ctx);
  expect(interactive.notifications.at(-1)).toContain("Burndown view: week");
  expect(persisted).toEqual(["week"]);

  await commands.get("burndown-view")?.handler("hour", interactive.ctx);
  expect(interactive.notifications.at(-1)).toContain("Burndown view: hour");
  expect(persisted).toEqual(["week", "five_hour"]);

  const completions = commands.get("burndown-view")?.getArgumentCompletions;
  expect(completions?.("")).toEqual([
    { value: "hour", label: "hour" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "all", label: "all" },
    { value: "status", label: "status" },
  ]);
  expect(completions?.("w")).toEqual([{ value: "week", label: "week" }]);
  expect(completions?.("zz")).toBeNull();

  await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, interactive.ctx);
  expect(interactive.widgets.at(-1)?.content).toBeUndefined();
});

test("headless and component-stubbing hosts degrade without throwing", async () => {
  const handlers = new Map<string, Handler>();
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  subscriptionBurndownExtension(api, {
    readPluginSettings: async () => ({}),
    persistWindowView: async () => undefined,
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
