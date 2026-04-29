import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredDeferredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "../plugins/channel-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}) {
  const startupProfileEnabled = process.env.OPENCLAW_GATEWAY_STARTUP_PROFILE === "1";
  let startupProfileLast = Date.now();
  const markStartupProfile = (label: string) => {
    if (!startupProfileEnabled) {
      return;
    }
    const now = Date.now();
    params.log.info(
      `[startup-profile] plugin bootstrap ${label}: +${now - startupProfileLast}ms`,
    );
    startupProfileLast = now;
  };
  const startupMaintenanceConfig =
    params.cfgAtStart.channels === undefined && params.startupRuntimeConfig.channels !== undefined
      ? {
          ...params.cfgAtStart,
          channels: params.startupRuntimeConfig.channels,
        }
      : params.cfgAtStart;

  if (!params.minimalTestGateway) {
    await runChannelPluginStartupMaintenance({
      cfg: startupMaintenanceConfig,
      env: process.env,
      log: params.log,
    });
    markStartupProfile("channel startup maintenance");
    await runStartupSessionMigration({
      cfg: params.cfgAtStart,
      env: process.env,
      log: params.log,
    });
    markStartupProfile("session migration");
  }

  initSubagentRegistry();
  markStartupProfile("subagent registry");

  const gatewayPluginConfigAtStart = params.minimalTestGateway
    ? params.cfgAtStart
    : applyPluginAutoEnable({
        config: params.cfgAtStart,
        env: process.env,
      }).config;
  markStartupProfile("plugin auto-enable");
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfigAtStart);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfigAtStart, defaultAgentId);
  markStartupProfile("workspace resolution");
  const deferredConfiguredChannelPluginIds = params.minimalTestGateway
    ? []
    : resolveConfiguredDeferredChannelPluginIds({
        config: gatewayPluginConfigAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  markStartupProfile("deferred channel ids");
  const startupPluginIds = params.minimalTestGateway
    ? []
    : resolveGatewayStartupPluginIds({
        config: gatewayPluginConfigAtStart,
        activationSourceConfig: params.cfgAtStart,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
      });
  markStartupProfile("startup plugin ids");

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;

  if (!params.minimalTestGateway) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = loadGatewayStartupPlugins({
      cfg: gatewayPluginConfigAtStart,
      activationSourceConfig: params.cfgAtStart,
      workspaceDir: defaultWorkspaceDir,
      log: params.log,
      coreGatewayHandlers,
      baseMethods,
      pluginIds: startupPluginIds,
      preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
      suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0,
    }));
    markStartupProfile("load startup plugins");
  } else {
    pluginRegistry = getActivePluginRegistry() ?? emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
  };
}
