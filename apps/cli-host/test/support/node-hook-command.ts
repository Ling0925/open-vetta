/** Use the test runner's Node even when a hook's login shell resets PATH. */
export function nodeHookCommand(scriptPath: string): string {
	if (process.platform === "win32") {
		// cmd /C removes the outer quotes; preserve quotes around both paths.
		return `""${process.execPath}" "${scriptPath}""`;
	}
	return [process.execPath, scriptPath].map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
}
