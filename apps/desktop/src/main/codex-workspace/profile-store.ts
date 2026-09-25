import { createVersionedJsonConfigStore } from "@vetta/toolkit/config-store";
import type { CodexWorkspaceProfile } from "../../shared/codex-workspace.js";
import { CodexWorkspaceError, keys, profile, record } from "./validation.js";

interface StoredProfile { schemaVersion: 1; profile?: CodexWorkspaceProfile; }
export function createCodexWorkspaceProfileStore(path: string) {
	const store = createVersionedJsonConfigStore<StoredProfile>({
		path, name: "codex-workspace-profile", readErrorPolicy: "throw",
		normalize(value) {
			if (value === undefined) return { schemaVersion: 1 };
			const parsed = record(value); keys(parsed, ["schemaVersion", "profile"]);
			if (parsed.schemaVersion !== 1) throw new CodexWorkspaceError("CONFIGURATION");
			return { schemaVersion: 1, ...(parsed.profile === undefined ? {} : { profile: profile(parsed.profile) }) };
		},
	});
	return {
		read: async () => (await store.read()).profile,
		write: (value: CodexWorkspaceProfile) => store.write({ schemaVersion: 1, profile: value })
	};
}
