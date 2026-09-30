import { mkdir, writeFile } from "node:fs/promises";
import { type Static, Type } from "@sinclair/typebox";
import type { RuntimeToolDefinition } from "@vetta/runtime-core/kernel";
import { localToolPathHost, resolveToCwd, resolveWritablePath } from "../../shared/path-resolution.js";
import { WRITE_TOOL_DESCRIPTION } from "./description.js";
import type { WriteOperations, WriteToolDetails, WriteToolOptions } from "./write-contracts.js";
import { captureWriteChange, readLocalFileForDiff } from "./write-diff.js";

export type {
	WriteDiffStatus,
	WriteDiffUnavailableReason,
	WriteFileSnapshot,
	WriteOperations,
	WritePathPolicy,
	WriteToolDetails,
	WriteToolOptions,
} from "./write-contracts.js";

export const WriteToolInputSchema = Type.Object({
	description: Type.Optional(
		Type.String({
			description: "Brief user-facing reason for this tool call (max 100 chars).",
			maxLength: 100,
		}),
	),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof WriteToolInputSchema>;

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => writeFile(path, content, "utf-8"),
	mkdir: (directory) => mkdir(directory, { recursive: true }).then(() => {}),
	readForDiff: readLocalFileForDiff,
};

export function createWriteTool(cwd: string, options: WriteToolOptions): RuntimeToolDefinition<WriteToolInput> {
	const operations = options.operations ?? defaultWriteOperations;
	const pathPolicy = options.pathPolicy;
	const pathHost = options.pathHost ?? localToolPathHost;
	return {
		name: "write",
		label: "write",
		description: WRITE_TOOL_DESCRIPTION,
		inputSchema: WriteToolInputSchema,
		async execute(request) {
			const { path, content } = request.input;
			const requestedPath = resolveToCwd(path, cwd, pathHost);
			const absolutePath = resolveWritablePath(path, cwd, pathHost);
			const rejectionReason = pathPolicy.getRejectionReason(absolutePath);
			if (rejectionReason !== undefined) {
				return {
					content: [
						{
							type: "text",
							text: rejectionReason,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const directory = pathHost.path.dirname(absolutePath);
			const pathRetargeted = requestedPath !== absolutePath;
			const notes = pathRetargeted ? [`[Auto-corrected output path: "${path}" -> "${absolutePath}"]`] : [];
			return executeWrite({
				operations,
				directory,
				absolutePath,
				content,
				notes,
				signal: request.signal,
			});
		},
	};
}

interface ExecuteWriteOptions {
	readonly operations: WriteOperations;
	readonly directory: string;
	readonly absolutePath: string;
	readonly content: string;
	readonly notes: readonly string[];
	readonly signal: AbortSignal;
}

async function executeWrite(options: ExecuteWriteOptions): Promise<{
	readonly content: readonly [{ readonly type: "text"; readonly text: string }];
	readonly details: WriteToolDetails;
}> {
	const assertActive = () => {
		if (options.signal.aborted) throw new Error("Operation aborted");
	};
	assertActive();
	const change = await captureWriteChange(options.operations, options.absolutePath, options.content, options.signal);
	assertActive();
	await options.operations.mkdir(options.directory);
	assertActive();
	// Once dispatched, wait for the owned write to settle. Cancellation cannot undo its filesystem effects.
	await options.operations.writeFile(options.absolutePath, options.content);
	assertActive();
	const bytesWritten = Buffer.byteLength(options.content, "utf8");
	return {
		content: [
			{
				type: "text",
				text:
					`${options.notes.join("\n")}${options.notes.length > 0 ? "\n" : ""}` +
					`Successfully wrote ${bytesWritten} bytes to ${options.absolutePath}`,
			},
		],
		details: { path: options.absolutePath, bytesWritten, ...change },
	};
}
