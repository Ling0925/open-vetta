import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { removeGeneratedPreviewEnvironment } from "./prepare-codex-preview-ci.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "vetta-preview-environment-"));
	roots.push(root);
	writeFileSync(join(root, ".env.example"), "PUBLIC_FLAG=false\n");
	return root;
}
test("removes only the byte-identical generated template and preserves the template", () => {
	const root = fixture();
	writeFileSync(join(root, ".env"), readFileSync(join(root, ".env.example")));
	assert.equal(removeGeneratedPreviewEnvironment(root), true);
	assert.equal(existsSync(join(root, ".env")), false);
	assert.equal(readFileSync(join(root, ".env.example"), "utf8"), "PUBLIC_FLAG=false\n");
	assert.equal(removeGeneratedPreviewEnvironment(root), false);
});
test("retains custom values, including an empty local environment", () => {
	const root = fixture();
	for (const content of ["synthetic-private-value", "", "PUBLIC_FLAG=true\n"]) {
		writeFileSync(join(root, ".env"), content);
		assert.throws(() => removeGeneratedPreviewEnvironment(root), /Custom .env retained/);
		assert.equal(readFileSync(join(root, ".env"), "utf8"), content);
	}
});
test("refuses a directory or symbolic link rather than deleting the target", () => {
	const root = fixture();
	const path = join(root, ".env");
	mkdirSync(path);
	assert.throws(() => removeGeneratedPreviewEnvironment(root), /non-regular/);
	rmSync(path, { recursive: true });
	symlinkSync(join(root, ".env.example"), path);
	assert.throws(() => removeGeneratedPreviewEnvironment(root), /non-regular/);
	assert.equal(readFileSync(join(root, ".env.example"), "utf8"), "PUBLIC_FLAG=false\n");
});
test("refuses cleanup when no checked-in comparison template is available", () => {
	const root = fixture();
	writeFileSync(join(root, ".env"), "synthetic-private-value");
	rmSync(join(root, ".env.example"));
	assert.throws(() => removeGeneratedPreviewEnvironment(root));
	assert.equal(readFileSync(join(root, ".env"), "utf8"), "synthetic-private-value");
});
