import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings, PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { WINDOW_VIEW_COMMAND_TOKENS, type WindowViewMode } from "./domain/window-class.ts";
import { IndicatorController } from "./runtime/controller.ts";

const PLUGIN_NAME = "omp-sub-burndown-indicator";

export interface ExtensionDependencies {
  /** Test seam: override controller construction. */
  controller?: IndicatorController;
  /** Test seam: override plugin-settings read. */
  readPluginSettings?: (ctx: { cwd: string }) => Promise<Readonly<Record<string, unknown>>>;
  /** Test seam: override windowView persistence (default writes omp-plugins.lock.json). */
  persistWindowView?: (cwd: string, mode: WindowViewMode) => Promise<void>;
}

async function defaultPluginSettings(ctx: {
  cwd: string;
}): Promise<Readonly<Record<string, unknown>>> {
  return getPluginSettings(PLUGIN_NAME, ctx.cwd);
}

async function defaultPersistWindowView(cwd: string, mode: WindowViewMode): Promise<void> {
  try {
    await new PluginManager(cwd).setPluginSetting(PLUGIN_NAME, "windowView", mode);
  } catch {
    // Persistence is best-effort; the live session still applies the mode.
  }
}

export { IndicatorController, WIDGET_KEY } from "./runtime/controller.ts";

export default function subscriptionBurndownExtension(
  pi: ExtensionAPI,
  dependencies: ExtensionDependencies = {},
): void {
  const controller = dependencies.controller ?? new IndicatorController();
  const readSettings = dependencies.readPluginSettings ?? defaultPluginSettings;
  const persistWindowView = dependencies.persistWindowView ?? defaultPersistWindowView;

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

  pi.registerCommand("burndown-status", {
    description: "Show subscription burndown source and freshness diagnostics",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(controller.status(), "info");
    },
  });

  pi.registerCommand("burndown-view", {
    description: "Set or cycle quota window view: hour, week, month, or all",
    getArgumentCompletions(argumentPrefix: string) {
      const prefix = argumentPrefix.trim().toLocaleLowerCase();
      const items = WINDOW_VIEW_COMMAND_TOKENS.filter((token) => token.startsWith(prefix)).map(
        (token) => ({ value: token, label: token }),
      );
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const result = controller.applyWindowViewCommand(args);
      if (result.changed) await persistWindowView(ctx.cwd, result.mode);
      if (ctx.hasUI) ctx.ui.notify(result.detail, "info");
    },
  });
}
