import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { IndicatorController } from "./runtime/controller.ts";

const PLUGIN_NAME = "omp-sub-burndown-indicator";
const USAGE =
  "Usage: /burndown status | view [hour|week|month|all] | labels <full|masked|provider-only> | density <dense|text> | layout <fit|wrap> | exhausted <status|reset|label <full|symbol>> | provider truncate <0-256>";

type MutablePluginSetting =
  | "accountLabels"
  | "density"
  | "exhaustedDisplay"
  | "exhaustedLabel"
  | "layout"
  | "providerLabelMaxColumns"
  | "windowView";
type MutableSettingValue = string | number;

export interface ExtensionDependencies {
  /** Test seam: override controller construction. */
  controller?: IndicatorController;
  /** Test seam: override plugin-settings read. */
  readPluginSettings?: (ctx: { cwd: string }) => Promise<Readonly<Record<string, unknown>>>;
  /** Test seam: override plugin-setting persistence. */
  persistPluginSetting?: (
    cwd: string,
    setting: MutablePluginSetting,
    value: MutableSettingValue,
  ) => Promise<void>;
}

async function defaultPluginSettings(ctx: {
  cwd: string;
}): Promise<Readonly<Record<string, unknown>>> {
  return getPluginSettings(PLUGIN_NAME, ctx.cwd);
}

async function defaultPersistPluginSetting(
  cwd: string,
  setting: MutablePluginSetting,
  value: MutableSettingValue,
): Promise<void> {
  await new PluginManager(cwd).setPluginSetting(PLUGIN_NAME, setting, value);
}

function completions(argumentPrefix: string): Array<{ value: string; label: string }> | null {
  const prefix = argumentPrefix.trimStart().toLocaleLowerCase();
  const values =
    prefix === "" || !prefix.includes(" ")
      ? ["status", "view", "labels", "density", "layout", "exhausted", "provider"]
      : prefix.startsWith("view ")
        ? ["view hour", "view week", "view month", "view all"]
        : prefix.startsWith("labels ")
          ? ["labels full", "labels masked", "labels provider-only"]
          : prefix.startsWith("density ")
            ? ["density dense", "density text"]
            : prefix.startsWith("layout ")
              ? ["layout fit", "layout wrap"]
              : prefix.startsWith("exhausted ")
                ? [
                    "exhausted status",
                    "exhausted reset",
                    "exhausted label full",
                    "exhausted label symbol",
                  ]
                : prefix.startsWith("provider ")
                  ? ["provider truncate"]
                  : [];
  const matches = values.filter((value) => value.startsWith(prefix));
  return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function displayChange(
  args: string,
):
  | { setting: Exclude<MutablePluginSetting, "windowView">; value: MutableSettingValue }
  | undefined {
  const tokens = args.trim().toLocaleLowerCase().split(/\s+/u);
  const [command, value, extra] = tokens;
  if (
    command === "labels" &&
    (value === "full" || value === "masked" || value === "provider-only") &&
    extra === undefined
  ) {
    return { setting: "accountLabels", value };
  }
  if (command === "density" && (value === "dense" || value === "text") && extra === undefined) {
    return { setting: "density", value };
  }
  if (command === "layout" && (value === "fit" || value === "wrap") && extra === undefined) {
    return { setting: "layout", value };
  }
  if (command === "exhausted" && (value === "status" || value === "reset") && extra === undefined) {
    return { setting: "exhaustedDisplay", value };
  }
  if (
    command === "exhausted" &&
    value === "label" &&
    (extra === "full" || extra === "symbol") &&
    tokens.length === 3
  ) {
    return { setting: "exhaustedLabel", value: extra };
  }
  if (
    command === "provider" &&
    value === "truncate" &&
    extra !== undefined &&
    tokens.length === 3 &&
    /^\d+$/u.test(extra) &&
    Number(extra) <= 256
  ) {
    return { setting: "providerLabelMaxColumns", value: Number(extra) };
  }
  return undefined;
}

export { IndicatorController, WIDGET_KEY } from "./runtime/controller.ts";

export default function subscriptionBurndownExtension(
  pi: ExtensionAPI,
  dependencies: ExtensionDependencies = {},
): void {
  const controller = dependencies.controller ?? new IndicatorController();
  const readSettings = dependencies.readPluginSettings ?? defaultPluginSettings;
  const persistSetting = dependencies.persistPluginSetting ?? defaultPersistPluginSetting;

  pi.on("session_start", async (_event, ctx) => {
    await controller.start(ctx, await readSettings(ctx));
  });
  pi.on("session_switch", async (_event, ctx) => {
    await controller.restart(ctx, await readSettings(ctx));
  });
  pi.on("session_tree", async (_event, ctx) => {
    await controller.restart(ctx, await readSettings(ctx));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown(ctx);
  });
  pi.on("after_provider_response", (event, ctx) => {
    controller.ingestResponse(event, ctx);
  });

  pi.registerCommand("burndown", {
    description: "Show or change subscription burndown display settings",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const normalized = args.trim();
      if (normalized === "status") {
        if (ctx.hasUI) ctx.ui.notify(controller.status(), "info");
        return;
      }

      const [command, view] = normalized.toLocaleLowerCase().split(/\s+/u);
      if (command === "view" && normalized.split(/\s+/u).length <= 2) {
        const result = controller.applyWindowViewCommand(view ?? "");
        if (result.changed) await persistSetting(ctx.cwd, "windowView", result.mode);
        if (ctx.hasUI) ctx.ui.notify(result.detail, "info");
        return;
      }

      const change = displayChange(normalized);
      if (!change) {
        if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
        return;
      }
      await persistSetting(ctx.cwd, change.setting, change.value);
      await controller.restart(ctx, await readSettings(ctx));
      if (ctx.hasUI) ctx.ui.notify("Burndown display updated.", "info");
    },
  });
}
