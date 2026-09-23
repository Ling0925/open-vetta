import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebAccessGrantInfo } from "../../shared/web-access.js";

export const WEB_ACCESS_COOKIE_NAME = "__Host-vetta-web";
export const WEB_ACCESS_HTTP_COOKIE_NAME = "vetta-web-session";
export const WEB_ACCESS_CSRF_HEADER = "x-vetta-csrf";
export const WEB_ACCESS_PAIRING_TTL_MS = 5 * 60_000;
export const WEB_ACCESS_GRANT_TTL_MS = 60 * 60_000;
export const WEB_ACCESS_MAX_GRANTS = 8;
export const WEB_ACCESS_MAX_PAIR_ATTEMPTS = 8;
export const WEB_ACCESS_PAIR_ATTEMPT_WINDOW_MS = 60_000;

export type WebAccessScope = "projects.read";

export interface WebAccessPairContext {
	readonly origin: string;
	readonly generation: number;
	readonly scopes: readonly WebAccessScope[];
}

interface WebAccessPairing {
	readonly hash: string;
	readonly expiresAt: number;
	readonly context: WebAccessPairContext;
}

export interface WebAccessGrant {
	readonly id: string;
	readonly cookieHash: string;
	readonly csrfHash: string;
	readonly csrfToken: string;
	readonly origin: string;
	readonly generation: number;
	readonly scopes: readonly WebAccessScope[];
	readonly createdAt: number;
	readonly expiresAt: number;
}

export type PairConsumeResult =
	| { readonly ok: true; readonly cookie: string; readonly csrf: string; readonly grant: WebAccessGrant }
	| { readonly ok: false; readonly reason: "invalid" | "expired" | "limit" };

export type AuthenticatedGrant = WebAccessGrant;

export class WebAccessAuthorization {
	private pairing: WebAccessPairing | undefined;
	private readonly grants = new Map<string, WebAccessGrant>();
	private pairAttemptWindowStartedAt = 0;
	private pairAttempts = 0;

	constructor(
		private readonly now: () => number = Date.now,
		private readonly random: () => string = () => randomBytes(32).toString("base64url"),
	) {}

	createPairing(context: WebAccessPairContext = { origin: "", generation: 0, scopes: ["projects.read"] }): {
		readonly code: string;
		readonly expiresAt: number;
	} {
		const code = this.random();
		const expiresAt = this.now() + WEB_ACCESS_PAIRING_TTL_MS;
		this.pairing = { hash: digest(code), expiresAt, context };
		this.pairAttemptWindowStartedAt = this.now();
		this.pairAttempts = 0;
		return { code, expiresAt };
	}

	consumePairing(
		code: string,
		context: WebAccessPairContext = { origin: "", generation: 0, scopes: ["projects.read"] },
	): PairConsumeResult {
		const now = this.now();
		if (now - this.pairAttemptWindowStartedAt >= WEB_ACCESS_PAIR_ATTEMPT_WINDOW_MS) {
			this.pairAttemptWindowStartedAt = now;
			this.pairAttempts = 0;
		}
		this.pairAttempts += 1;
		if (this.pairAttempts > WEB_ACCESS_MAX_PAIR_ATTEMPTS) return { ok: false, reason: "limit" };
		const pairing = this.pairing;
		if (!pairing || pairing.expiresAt <= now) {
			this.pairing = undefined;
			return { ok: false, reason: "expired" };
		}
		if (
			!safeEqual(pairing.hash, digest(code)) ||
			pairing.context.origin !== context.origin ||
			pairing.context.generation !== context.generation ||
			pairing.context.scopes.join(",") !== context.scopes.join(",")
		)
			return { ok: false, reason: "invalid" };
		if (this.grants.size >= WEB_ACCESS_MAX_GRANTS) return { ok: false, reason: "limit" };
		this.pairing = undefined;
		return { ok: true, ...this.createGrant(now, context) };
	}

	bootstrap(
		cookie: string,
		context?: Pick<WebAccessPairContext, "origin" | "generation">,
	): { readonly csrf: string; readonly grant: WebAccessGrant } | undefined {
		const grant = this.findByCookie(cookie);
		if (!grant || (context && (grant.origin !== context.origin || grant.generation !== context.generation)))
			return undefined;
		return { csrf: grant.csrfToken, grant };
	}

	authenticate(
		cookie: string,
		csrf: string,
		context?: Pick<WebAccessPairContext, "origin" | "generation">,
	): AuthenticatedGrant | undefined {
		const grant = this.findByCookie(cookie);
		if (
			!grant ||
			!safeEqual(grant.csrfHash, digest(csrf)) ||
			(context && (grant.origin !== context.origin || grant.generation !== context.generation))
		)
			return undefined;
		return grant;
	}

	isActive(grantId: string): boolean {
		const grant = this.grants.get(grantId);
		return Boolean(grant && grant.expiresAt > this.now());
	}

	logout(cookie: string, csrf: string, context?: Pick<WebAccessPairContext, "origin" | "generation">): boolean {
		const grant = this.authenticate(cookie, csrf, context);
		if (!grant) return false;
		return this.revoke(grant.id);
	}

	revoke(grantId: string): boolean {
		return this.grants.delete(grantId);
	}

	revokeAll(): readonly string[] {
		const ids = [...this.grants.keys()];
		this.grants.clear();
		this.pairing = undefined;
		return ids;
	}

	listGrants(): readonly WebAccessGrantInfo[] {
		const now = this.now();
		for (const [id, grant] of this.grants) {
			if (grant.expiresAt <= now) this.grants.delete(id);
		}
		return [...this.grants.values()].map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt }));
	}

	getPairingExpiresAt(): number | undefined {
		return this.pairing && this.pairing.expiresAt > this.now() ? this.pairing.expiresAt : undefined;
	}

	private createGrant(
		now: number,
		context: WebAccessPairContext,
	): {
		readonly cookie: string;
		readonly csrf: string;
		readonly grant: WebAccessGrant;
	} {
		const cookie = this.random();
		const csrf = this.random();
		const grant: WebAccessGrant = {
			id: randomUUID(),
			cookieHash: digest(cookie),
			csrfHash: digest(csrf),
			csrfToken: csrf,
			origin: context.origin,
			generation: context.generation,
			scopes: context.scopes,
			createdAt: now,
			expiresAt: now + WEB_ACCESS_GRANT_TTL_MS,
		};
		this.grants.set(grant.id, grant);
		return { cookie, csrf, grant };
	}

	private findByCookie(cookie: string): WebAccessGrant | undefined {
		const hash = digest(cookie);
		const now = this.now();
		for (const [id, grant] of this.grants) {
			if (grant.expiresAt <= now) {
				this.grants.delete(id);
				continue;
			}
			if (safeEqual(grant.cookieHash, hash)) return grant;
		}
		return undefined;
	}
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left, "hex");
	const b = Buffer.from(right, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}
