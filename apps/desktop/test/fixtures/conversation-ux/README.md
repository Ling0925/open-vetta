# Conversation UX browser fixture

This isolated loopback page mounts the production `useSessionEventController`, Jotai
message atoms, `MessageList`, message cards, virtualizer, scrolling hooks and renderer
styles. Only the Electron preload boundary is replaced. It uses synthetic messages
and never starts Electron, a model, a shell tool, or an account session.

Install the repository's locked dependencies through the usual workflow first, then
run from `apps/desktop`:

```sh
env -i PATH="$PATH" HOME=/tmp/vetta-ux-home TMPDIR=/tmp \
  bun x --no-install vite --config test/fixtures/conversation-ux/vite.config.mjs
```

Open `http://127.0.0.1:4173/` in an ordinary browser on the same machine that supports
loopback access. The managed cloud CDP browser used for this review blocked this URL
with `ERR_BLOCKED_BY_CLIENT`; no extension was disabled and no alternate route was
used. Browser screenshots and real layout/scrolling have therefore not been verified.
This is a component/IPC-boundary fixture, not a real-provider or packaged-Electron
end-to-end test.

From the repository root, the fixture's component checks run through the standard
test wrapper (the fixture config restricts collection to this directory):

```sh
bun scripts/quality/run-vitest.mjs --run \
  --config apps/desktop/test/fixtures/conversation-ux/vitest.config.mts \
  test/fixtures/conversation-ux/fixture.test.tsx
bun x --no-install tsgo --noEmit -p apps/desktop/test/fixtures/conversation-ux/tsconfig.json
```

The jsdom checks use the real components with Virtuoso's fixed-size mock context
and deterministic measurement shims. They verify rendered state and control wiring,
not browser pixel geometry or real scrolling performance.

## Repeatable checks

1. Start a new turn and stream output. Confirm that the displayed reply keeps growing
   at the bottom. Scroll upward during streaming; browsing history must not be pulled
   down. Return to the bottom and confirm following resumes.
2. Switch between A and B during streaming and inject an obsolete event. A must not
   appear in B and vice versa. Each session intentionally has distinct marker text.
3. Start a tool, publish progress, then finish it. Open the real tool card and inspect
   the pending, partial-output and completed states.
4. Cancel while streaming, then start a new turn. The latest reply and running state
   must be correct without a ghost tool or a stuck previous-turn indicator.
5. Complete a turn, immediately start another, then release the held old history.
   The prior response must not erase the new question or streaming reply.
6. Complete a turn, switch A → B → A, then release old history. It must not replace
   the state from the newer visit.
7. Prepend 50 history rows and exercise real browser scrolling, virtualization,
   session switching, and the last-message timeline navigation.

The left panel is fixture-only control UI, not a proposed product redesign. Session
selection is deliberately deterministic and does not emulate the full session manager,
preload transport, filesystem restoration, or backend scheduler. Deferred history is
released explicitly; no network delay is used as a correctness oracle.
