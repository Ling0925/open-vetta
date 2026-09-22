import { describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	loadCredentials: vi.fn(),
	loadState: vi.fn(),
	saveConfig: vi.fn(),
	saveCredentials: vi.fn(() => ({ mode: "plaintext" as const })),
}));

vi.mock("../ipc/fs.js", () => ({ DEFAULT_IM_CONVERSATION_CWD: "/controlled/im-conversation" }));
vi.mock("../logger.js", () => ({
	getAppLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../models/probe.js", () => ({ probeModelProvider: vi.fn() }));
vi.mock("./binary-resolver.js", () => ({ resolveImGatewayBinary: vi.fn() }));
vi.mock("./channels.js", () => ({ getImChannelDescriptor: vi.fn() }));
vi.mock("./coding-agent-spec.js", () => ({ buildCodingAgentSpec: vi.fn() }));
vi.mock("./config-store.js", () => ({
	defaultImConfig: () => ({
		enabled: false,
		transport: "feishu",
		feishu: { appId: "" },
		wechat: { bound: false },
		telegram: {},
		slack: {},
		discord: {},
		signal: { bound: false },
		whatsapp: { bound: false },
		imessage: {},
		transportMode: "long-connection",
	}),
	defaultImConfigPath: () => "/controlled/im-config.json",
	defaultSignalConfigDir: () => "/controlled/signal",
	defaultWechatStatePath: () => "/controlled/wechat.json",
	defaultWhatsappStatePath: () => "/controlled/whatsapp.db",
	loadImConfig: persistence.loadConfig,
	saveImConfig: persistence.saveConfig,
}));
vi.mock("./credential-store.js", () => ({
	defaultCredentialsPath: () => "/controlled/im-credentials.json",
	loadCredentials: persistence.loadCredentials,
	saveCredentials: persistence.saveCredentials,
}));
vi.mock("./migration.js", () => ({ archiveLegacyFiles: vi.fn(), detectLegacyImGateway: vi.fn() }));
vi.mock("./proxy-env.js", () => ({ electronProxyResolver: vi.fn(), resolveSidecarProxyEnv: vi.fn() }));
vi.mock("./sidecar-manager.js", () => ({
	SidecarManager: class {
		getCurrentChild(): undefined {
			return undefined;
		}
		async stop(): Promise<void> {}
	},
}));
vi.mock("./signal-cli-locator.js", () => ({
	detectSignalCli: () => ({ installHint: "controlled install hint" }),
}));
vi.mock("./state-store.js", () => ({
	applyStatePatch: vi.fn(),
	defaultImStatePath: () => "/controlled/im-state.json",
	loadImState: persistence.loadState,
	saveImState: vi.fn(),
}));

import { ImHost } from "./index.js";

describe("ImHost startup preparation", () => {
	it("loads persisted credentials before a settings update can save host state", async () => {
		persistence.loadConfig.mockReturnValue({
			enabled: false,
			transport: "feishu",
			feishu: { appId: "persisted-app" },
			wechat: { bound: false },
			telegram: {},
			slack: {},
			discord: {},
			signal: { bound: false },
			whatsapp: { bound: false },
			imessage: {},
			transportMode: "long-connection",
		});
		persistence.loadCredentials.mockReturnValue({
			feishu: { appSecret: "persisted-secret", verificationToken: "persisted-token" },
		});
		persistence.loadState.mockReturnValue({ version: 3, sessions: [] });
		const host = new ImHost();

		host.prepare();
		host.prepare();
		await expect(host.setConfig({ enabled: false })).resolves.toMatchObject({ ok: true });
		await host.bootstrap();

		expect(persistence.loadConfig).toHaveBeenCalledOnce();
		expect(persistence.loadCredentials).toHaveBeenCalledOnce();
		expect(persistence.loadState).toHaveBeenCalledOnce();
		expect(persistence.saveCredentials).toHaveBeenCalledWith({
			feishu: { appSecret: "persisted-secret", verificationToken: "persisted-token" },
		});
		expect(host.getPublicConfig().feishu).toMatchObject({
			appId: "persisted-app",
			appSecret: "persisted-secret",
			verificationToken: "persisted-token",
		});
	});
});
