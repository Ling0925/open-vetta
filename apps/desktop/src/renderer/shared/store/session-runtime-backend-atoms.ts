import { atom } from "jotai";
import type { SessionRuntimeBackend } from "../../../shared/session-runtime-backend";

/** Only uncreated conversations use this draft-scoped choice. Existing choices live in their journal. */
export const draftRuntimeBackendsAtom = atom<Record<string, SessionRuntimeBackend>>({});
