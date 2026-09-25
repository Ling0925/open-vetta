import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Remove only an untouched postinstall template from a disposable CI checkout.
 * Never print its contents or accept a developer's custom environment as a template. */
export function removeGeneratedPreviewEnvironment(desktopRoot) {
	const path = join(desktopRoot, ".env");
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
		throw new Error("Refusing to remove a non-regular preview environment file");
	const template = join(desktopRoot, ".env.example");
	const templateStat = lstatSync(template);
	if (!templateStat.isFile() || templateStat.isSymbolicLink() || templateStat.size > 1024 * 1024)
		throw new Error("Invalid checked-in environment template");
	if (!readFileSync(path).equals(readFileSync(template)))
		throw new Error("Custom .env retained; build the preview in a clean checkout");
	unlinkSync(path);
	return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	if (process.env.GITHUB_ACTIONS !== "true" || process.argv.length !== 2)
		throw new Error("This cleanup entrypoint is restricted to a disposable GitHub Actions checkout");
	const removed = removeGeneratedPreviewEnvironment(fileURLToPath(new URL("..", import.meta.url)));
	console.log(
		removed
			? "Removed unchanged postinstall template for isolated preview packaging"
			: "No generated environment to remove",
	);
}
