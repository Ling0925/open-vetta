import { atom } from "jotai";

/** Drafts are scoped to Codex sessions, never shared with Native chat or persisted as credentials. */
export const codexWorkspaceDraftsAtom = atom<Readonly<Record<string, string>>>({});
