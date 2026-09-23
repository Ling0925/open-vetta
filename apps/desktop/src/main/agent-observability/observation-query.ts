import { traceIdentifier, traceObject } from "@vetta/runtime-telemetry";
import type { AgentObservationQuery, AgentObservationSummaryQuery } from "./contracts.js";

export function parseAgentObservationQuery(input: unknown): AgentObservationQuery {
	const value = traceObject(input);
	if (
		!value ||
		!traceIdentifier(value.sessionId) ||
		Object.keys(value).some(
			(key) => !["sessionId", "turnId", "traceId", "errorsOnly", "cursor", "limit"].includes(key),
		) ||
		(value.turnId !== undefined && !traceIdentifier(value.turnId)) ||
		(value.traceId !== undefined && !traceIdentifier(value.traceId)) ||
		(value.errorsOnly !== undefined && typeof value.errorsOnly !== "boolean") ||
		(value.limit !== undefined &&
			(typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200)) ||
		(value.cursor !== undefined &&
			(typeof value.cursor !== "string" || !/^\d+(?:\.\d+)?:[\w.:/@+-]{1,256}$/.test(value.cursor)))
	)
		throw new Error("TRACE_QUERY_INVALID");
	return {
		sessionId: value.sessionId as string,
		turnId: value.turnId as string | undefined,
		traceId: value.traceId as string | undefined,
		errorsOnly: value.errorsOnly as boolean | undefined,
		limit: value.limit as number | undefined,
		cursor: value.cursor as string | undefined,
	};
}

/** Aggregation window must stay bounded so a rogue caller cannot scan the whole 7-day buffer. */
const SUMMARY_MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export function parseAgentObservationSummaryQuery(input: unknown): AgentObservationSummaryQuery {
	const value = traceObject(input);
	if (
		!value ||
		Object.keys(value).some((key) => !["from", "to", "sessionId"].includes(key)) ||
		typeof value.from !== "number" ||
		!Number.isFinite(value.from) ||
		value.from < 0 ||
		typeof value.to !== "number" ||
		!Number.isFinite(value.to) ||
		value.to <= value.from ||
		value.to - value.from > SUMMARY_MAX_WINDOW_MS ||
		(value.sessionId !== undefined && !traceIdentifier(value.sessionId))
	)
		throw new Error("TRACE_QUERY_INVALID");
	return {
		from: value.from,
		to: value.to,
		sessionId: value.sessionId as string | undefined,
	};
}
