import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: string) => value),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshot: vi.fn(),
  getChannelActivity: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.status", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("channelsHandlers channels.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.normalizeChannelId.mockImplementation((value: string) => value);
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: ["whatsapp"],
      labels: { whatsapp: "WhatsApp" },
      detailLabels: { whatsapp: "WhatsApp" },
      systemImages: { whatsapp: undefined },
      entries: { whatsapp: { id: "whatsapp" } },
    });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async (_account: unknown, cfg: { autoEnabled?: boolean }) =>
            Boolean(cfg.autoEnabled),
        },
      },
    ]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    const respond = vi.fn();
    const opts = createOptions(
      { probe: false, timeoutMs: 2000 },
      {
        respond,
      },
    );

    await channelsHandlers["channels.status"](opts);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.buildChannelAccountSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledConfig,
        accountId: "default",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channels: {
          whatsapp: expect.objectContaining({
            configured: true,
          }),
        },
      }),
      undefined,
    );
  });

  it("returns runtime-only channels after lazy manual start", async () => {
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: [],
      labels: {},
      detailLabels: {},
      systemImages: {},
      entries: {},
    });
    const respond = vi.fn();

    await channelsHandlers["channels.status"](
      createOptions(
        { probe: false, timeoutMs: 2000 },
        {
          respond,
          context: {
            getRuntimeSnapshot: () => ({
              channels: {
                feishu: {
                  accountId: "default",
                  configured: true,
                  running: true,
                  connected: true,
                },
              },
              channelAccounts: {
                feishu: {
                  default: {
                    accountId: "default",
                    configured: true,
                    running: true,
                    connected: true,
                  },
                },
              },
            }),
          } as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channels: {
          feishu: expect.objectContaining({
            running: true,
            connected: true,
          }),
        },
        channelAccounts: {
          feishu: [
            expect.objectContaining({
              accountId: "default",
              running: true,
            }),
          ],
        },
        channelDefaultAccountId: {
          feishu: "default",
        },
      }),
      undefined,
    );
  });

  it("starts a lazy bundled channel that is not in the loaded channel registry", async () => {
    const startChannel = vi.fn(async () => undefined);
    mocks.normalizeChannelId.mockReturnValue(null);
    mocks.getChannelPlugin.mockImplementation((id: string) =>
      id === "feishu"
        ? {
            id: "feishu",
            gateway: {
              startAccount: vi.fn(),
            },
          }
        : undefined,
    );
    const respond = vi.fn();

    await channelsHandlers["channels.start"](
      createOptions(
        { channel: "feishu" },
        {
          respond,
          context: {
            getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
            startChannel,
          } as unknown as GatewayRequestHandlerOptions["context"],
        },
      ),
    );

    expect(startChannel).toHaveBeenCalledWith("feishu", undefined);
    expect(respond).toHaveBeenCalledWith(
      true,
      { channel: "feishu", accountId: null },
      undefined,
    );
  });
});
