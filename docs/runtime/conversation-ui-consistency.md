# Conversation presentation consistency

The conversation view combines a persisted history snapshot with live events. Its
performance optimizations must preserve the same visible state and ordering as an
unbatched, session-scoped update stream.

## Ownership and ordering

- A history request belongs to one visit, one turn/input generation and one queue
  dispatch sequence. A newer turn, queue consumption, compaction, session reset or
  disposal invalidates the old request. Reopening the same runtime ID does not revive it.
- A history response must still belong to the active stream owner before changing
  the message list. Request-time identities are captured before the asynchronous read.
- Raw assistant events keep their identity-scoped ordered reducer. Compatibility
  text/thinking deltas are buffered in arrival order; only adjacent fragments of the
  same type are combined. The existing 100 ms render-batching ceiling remains.
- A terminal history refresh may keep the live blocks only when their durable
  identities and visible text, thinking and persisted tool results agree. A missing
  delta or final-only notification must not leave an empty answer or a pending tool.

## Restoring an active conversation

A tail preview and the full history are independent reads. While the full history
loads, the restored assistant can already receive text, tool results or completion.
Those updates may retain the preview row's durable ID; retaining only *new* IDs is
therefore insufficient.

Full-history backfill preserves updated restored rows, while still incorporating
older history and canonical tool results. An already durable completed snapshot
must not be revived as streaming. Text matching proceeds in display order and
cannot merge a paragraph after a tool into a similar paragraph before that tool.
New tail-only drafts and complete restored preview rows have different matching
origins. Unchanged history retains its existing array/object references.

## Viewport and navigation

- Scheduled animation-frame reads and scroll commands belong to a specific feed,
  viewport and navigation target. Switching feeds, changing targets and unmounting
  cancel obsolete work.
- Programmatic navigation turns off auto-follow until the user returns to the tail.
  A successful target scroll consumes the request; scheduling it is not success.
- A fork-origin target includes the destination session path. An unrelated session
  with the same entry ID cannot consume it.
- Tail previews may not contain an older target. Keep the target until full history
  provides it rather than clearing it and jumping to the bottom. If the entry is
  permanently unavailable, no guessed location is used; the pending target does not
  block sending messages and remains scoped to its destination session.
- A superseded or unsuccessful open clears only its own navigation request, never
  a later request.

Shallow memoization, stable render keys, Virtuoso virtualization and per-frame
layout-read coalescing remain enabled. These guards address ownership and lifetime;
they do not replace the existing rendering strategy.

## Regression coverage

Use the repository's official Node-hosted Vitest wrapper. Run from the repository
root after installing the locked dependencies and building required workspaces:

```sh
bun scripts/quality/run-vitest.mjs --run --config apps/desktop/vitest.config.ts \
  src/renderer/domains/conversation/hooks/useSessionEventController.ordering.test.ts \
  src/renderer/domains/conversation/services/live-history-patch.test.ts \
  src/renderer/domains/conversation/services/chat-message-snapshot.test.ts \
  src/renderer/domains/conversation/services/chat-message-snapshot.live-backfill.test.ts \
  src/renderer/domains/conversation/hooks/useSessionManager.session-switch.test.ts \
  src/renderer/domains/conversation/components/SessionMessageList.navigation.test.tsx \
  src/renderer/shared/components/message-feed/useMessageFeedScrollModel.navigation.test.tsx \
  src/renderer/shared/components/message-feed/useMessageFeedActiveItem.test.tsx
```

These tests use explicit event/deferred-response/frame boundaries and synthetic
preload data. They do not require a real provider or account credentials.

The [conversation browser fixture](../../apps/desktop/test/fixtures/conversation-ux/README.md)
mounts the production event controller, store and message components. Its jsdom
smoke checks verify wiring and state. Real-browser scrolling, layout, themes and
screenshots remain separate visual checks; a jsdom size shim is not evidence of
pixel-level correctness or packaged-Electron behavior.
