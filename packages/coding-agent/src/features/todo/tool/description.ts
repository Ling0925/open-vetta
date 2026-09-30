export const TODO_TOOL_DESCRIPTION = `Manage a todo list to plan and track progress on multi-step tasks.

Create a todo plan only when you will execute and track the work in the current task:
- Task requires 3 or more distinct steps
- User asks to modify multiple files
- Task involves sequential work (step A must finish before step B)
- User explicitly asks you to track an execution plan or todo list while carrying out the work

When NOT to create:
- Single file edit or simple question
- Task completable in 1-2 trivial steps
- Purely informational or conversational request, including a request to explain, propose, or review a plan without executing it

Workflow:
1. If a todo list may already exist, call todo(action="list") before creating a new plan.
2. Call todo(action="create") with all planned steps BEFORE starting any work, but only when the list is empty.
3. Call todo(action="update", id=N, status="in_progress") when you START a step.
4. Call todo(action="update", id=N, status="done") when you FINISH a step.
5. Update status in real time. When completing one step and starting the next, use todo(action="replace", plan=[{content, status}, ...]) to publish the complete updated plan atomically. At most one step may be in_progress. Existing step identities are retained when their descriptions are unchanged.
6. Prefer completing items in order, but you MAY reprioritize or update out of order when it makes sense.
7. If the user changes direction, use replace with the complete revised plan so the UI never sees a temporary empty plan. Use clear when abandoning the plan entirely.

Never call create to start a new plan when a todo list already exists. Create does not append a new plan to an existing plan: it will be rejected. First call list, then either continue the existing plan or clear it if obsolete.

Aim to finish the items you committed to — don't abandon a plan halfway without reason. If the user has redirected you, clear the stale plan rather than ignoring it.

NOTE — locked lists are STRICT: lists created from a scene's tasks.json are locked. For a locked list you MUST complete items in strict sequential order by ID, you CANNOT create or clear items, and you MUST finish every item before stopping. Atomic replace may change statuses only; every step description and its order must remain unchanged. Out-of-order updates and clear are REJECTED, and the system will force you to continue if you stop early.`;
