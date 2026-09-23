import type { WebAccessProjectEntry, WebAccessProjectSnapshot } from "../../shared/web-access.js";
import type { ProjectChangeHub } from "../projects/project-change-hub.js";
import type { ProjectListSnapshot, ProjectService } from "../projects/project-service.js";

export interface ProjectSnapshotSource {
	read(): Promise<WebAccessProjectSnapshot>;
	getPosition?(): { readonly generation: string; readonly cursor: number };
	waitForChange(
		generation: string | undefined,
		cursor: number | undefined,
		signal: AbortSignal,
		waitMs: number,
	): Promise<{ readonly changed: boolean; readonly snapshot: WebAccessProjectSnapshot }>;
}

export class DesktopProjectSnapshotSource implements ProjectSnapshotSource {
	constructor(
		private readonly projects: Pick<ProjectService, "list">,
		private readonly changes: ProjectChangeHub,
		private readonly maxReadAttempts = 3,
	) {}

	async read(): Promise<WebAccessProjectSnapshot> {
		let latest: WebAccessProjectSnapshot | undefined;
		for (let attempt = 0; attempt < this.maxReadAttempts; attempt += 1) {
			const before = this.changes.getCursor();
			const snapshot = await this.projects.list();
			const after = this.changes.getCursor();
			latest = toWebSnapshot(this.changes.getGeneration(), after, snapshot);
			if (before === after) return latest;
		}
		throw new Error("Project list changed continuously; retry the snapshot request");
	}

	getPosition(): { readonly generation: string; readonly cursor: number } {
		return { generation: this.changes.getGeneration(), cursor: this.changes.getCursor() };
	}

	async waitForChange(
		generation: string | undefined,
		cursor: number | undefined,
		signal: AbortSignal,
		waitMs: number,
	): Promise<{ readonly changed: boolean; readonly snapshot: WebAccessProjectSnapshot }> {
		const currentGeneration = this.changes.getGeneration();
		const currentCursor = this.changes.getCursor();
		if (generation !== currentGeneration || cursor === undefined || cursor !== currentCursor) {
			return { changed: true, snapshot: await this.read() };
		}
		const changed = await this.changes.waitForChange(cursor, signal, waitMs);
		return { changed, snapshot: await this.read() };
	}
}

function toWebSnapshot(generation: string, cursor: number, snapshot: ProjectListSnapshot): WebAccessProjectSnapshot {
	return {
		generation,
		cursor,
		projects: snapshot.projects.map(toEntry),
		archivedProjects: snapshot.archivedProjects.map(toEntry),
	};
}

function toEntry(entry: { readonly path: string; readonly name?: string }): WebAccessProjectEntry {
	return entry.name ? { path: entry.path, name: entry.name } : { path: entry.path };
}
