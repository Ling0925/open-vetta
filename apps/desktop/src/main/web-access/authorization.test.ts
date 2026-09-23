import { describe, expect, it } from "vitest";
import { WEB_ACCESS_GRANT_TTL_MS, WEB_ACCESS_PAIRING_TTL_MS, WebAccessAuthorization } from "./authorization.js";

describe("WebAccessAuthorization", () => {
	it("consumes a pairing code once, keeps CSRF stable across bootstrap, and revokes independently", () => {
		const now = 1_000;
		const values = ["pair-code", "cookie-secret", "csrf-secret"];
		const auth = new WebAccessAuthorization(
			() => now,
			() => values.shift() ?? "fallback",
		);

		const pairing = auth.createPairing();
		expect(pairing.expiresAt).toBe(now + WEB_ACCESS_PAIRING_TTL_MS);
		const consumed = auth.consumePairing("pair-code");
		if (!consumed.ok) throw new Error("pairing should be accepted");
		expect(consumed.grant.expiresAt).toBe(now + WEB_ACCESS_GRANT_TTL_MS);
		expect(auth.consumePairing("pair-code")).toMatchObject({ ok: false, reason: "expired" });
		expect(auth.authenticate(consumed.cookie, consumed.csrf)?.id).toBe(consumed.grant.id);

		const bootstrapped = auth.bootstrap(consumed.cookie);
		expect(bootstrapped?.csrf).toBe(consumed.csrf);
		expect(auth.authenticate(consumed.cookie, consumed.csrf)?.id).toBe(consumed.grant.id);
		expect(auth.authenticate(consumed.cookie, bootstrapped?.csrf ?? "")?.id).toBe(consumed.grant.id);
		expect(auth.revoke(consumed.grant.id)).toBe(true);
		expect(auth.listGrants()).toEqual([]);
	});

	it("expires pairing and grants using the injected clock", () => {
		let now = 5_000;
		const auth = new WebAccessAuthorization(
			() => now,
			() => "fixed-secret",
		);
		const pairing = auth.createPairing();
		now = pairing.expiresAt + 1;
		expect(auth.consumePairing("fixed-secret")).toMatchObject({ ok: false, reason: "expired" });
	});

	it("binds pairings to origin and lifecycle generation and clears pending invitations on revokeAll", () => {
		const auth = new WebAccessAuthorization(
			() => 1_000,
			() => "pair-code",
		);
		const pairing = auth.createPairing({ origin: "https://web.test", generation: 1, scopes: ["projects.read"] });
		expect(
			auth.consumePairing(pairing.code, {
				origin: "https://evil.test",
				generation: 1,
				scopes: ["projects.read"],
			}),
		).toMatchObject({ ok: false });
		auth.revokeAll();
		expect(
			auth.consumePairing(pairing.code, {
				origin: "https://web.test",
				generation: 1,
				scopes: ["projects.read"],
			}),
		).toMatchObject({ ok: false });
		expect(WEB_ACCESS_GRANT_TTL_MS).toBe(60 * 60_000);
	});
});
