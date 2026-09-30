import * as Diff from "diff";

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { readonly diff: string; readonly firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumberWidth = String(Math.max(oldLines.length, newLines.length)).length;
	let oldLineNumber = 1;
	let newLineNumber = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const raw = part.value.split("\n");
		if (raw.at(-1) === "") raw.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLineNumber;
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
					newLineNumber++;
				} else {
					output.push(`-${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
					oldLineNumber++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[index + 1];
		const nextPartIsChange = nextPart !== undefined && (nextPart.added === true || nextPart.removed === true);
		if (!lastWasChange && !nextPartIsChange) {
			oldLineNumber += raw.length;
			newLineNumber += raw.length;
			lastWasChange = false;
			continue;
		}

		let linesToShow = raw;
		let skipStart = 0;
		let skipEnd = 0;
		if (!lastWasChange) {
			skipStart = Math.max(0, raw.length - contextLines);
			linesToShow = raw.slice(skipStart);
		}
		if (!nextPartIsChange && linesToShow.length > contextLines) {
			skipEnd = linesToShow.length - contextLines;
			linesToShow = linesToShow.slice(0, contextLines);
		}
		if (skipStart > 0) {
			output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
			oldLineNumber += skipStart;
			newLineNumber += skipStart;
		}
		for (const line of linesToShow) {
			output.push(` ${String(oldLineNumber).padStart(lineNumberWidth, " ")} ${line}`);
			oldLineNumber++;
			newLineNumber++;
		}
		if (skipEnd > 0) {
			output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
			oldLineNumber += skipEnd;
			newLineNumber += skipEnd;
		}
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}
