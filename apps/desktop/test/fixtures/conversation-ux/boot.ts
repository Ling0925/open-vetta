import { installFixturePreload } from "./host";

installFixturePreload();
void import("./main")
	.then(({ mountFixture }) => mountFixture())
	.catch((error: unknown) => {
		document.getElementById("root")!.textContent = `Fixture failed: ${String(error)}`;
		console.error(error);
	});
