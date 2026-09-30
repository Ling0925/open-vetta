# Validation scope

## Verified in the isolated execution workspace

- Production renderer components and styles compile through the fixture Vite build
- Real `useSessionEventController` → default Jotai store → `MessageList` → Virtuoso
  → message/tool-card wiring mounts in jsdom
- Four component checks pass: successive text updates and cancellation; A → B → A
  isolation and obsolete events; cancellation/new-turn protection from delayed history;
  tool progress followed by the final result in the expanded production tool card
- The fixture TS/TSX, its tests and imported production code type-check using the
  fixture tsconfig and `tsgo --noEmit`

The component checks use Virtuoso's fixed-size mock context plus explicit 600px
measurement and scroll-event shims. Their assertions concern rendered content and
state transitions. They are not evidence of actual pixel layout or scroll anchoring.

## Not verified here

- Browser screenshots, real scroll-follow, user-wheel interruption, return-to-bottom,
  viewport restoration, narrow-window layout, and animation/performance
- Native Electron/preload/IPC transport, full session-manager restoration, or real
  model/provider execution

The managed cloud browser displayed `ERR_BLOCKED_BY_CLIENT` for the loopback preview,
with an extension-blocked-page message. No extension, proxy, permission, or security
setting was changed and no alternate route was used. The README provides the exact
same-machine preview command for subsequent browser verification.

## Additional regression checks

Independent helper reproductions identified and then verified fixes for two hydration
merge cases: post-tool text sharing a prefix with pre-tool text must not move before
the tool; a canonical snapshot that already contains a tool must not duplicate the
same restored text block when the live event stream has not reached that tool yet.
The regression tests for those cases exercise the history-merge service separately
from this fixture.
