# Verification

Before you report a task complete, prove it works. This file is the playbook.

## The rule

Don't say "fixed" or "done" or "shipped" until you've watched the change behave correctly. If you cannot verify, say so explicitly: "Wrote the change but couldn't run the suite because X."

The user is making decisions based on what you report. A false "all tests pass" is far worse than "tests didn't run, here's why."

## By change type

### Code change with tests

1. Run the test you added (or the existing test the change affects).
2. Run the test suite for the package: `pnpm --filter <pkg> test`, `pytest tests/`, etc.
3. Run the type-checker if the language has one: `pnpm check-types`, `mypy`, `cargo check`.
4. Read the output. "Exit code 0" is necessary but not sufficient — sometimes tests are skipped or the runner reports green on no-op runs.

### Tool/CLI change

1. Invoke the tool with a real input.
2. Read the output. Confirm it matches the expected shape.
3. Try an edge case (empty input, malformed input, missing flag) if the change affects error paths.

### Backend/API change

1. Hit the endpoint with `curl` or the equivalent. Confirm status code and response shape.
2. Check any persisted side effect (DB row, file written, queue message) actually happened.
3. Run any integration tests that cover the endpoint.

### UI / frontend change

This one is non-negotiable: **open it in a browser**. Type-checks and unit tests verify code correctness, not feature correctness.

1. Start the dev server with `process` action `start` if it needs to stay running while you use the browser. For a one-shot build or bounded verification command, use `process` action `run` so the completed output returns to the conversation without manual polling.
2. Open the page. The `playwright-cli` skill is the right tool — it drives a real browser interactively without you writing a Playwright script.
3. Click through the golden path of the feature you changed.
4. Try one edge case (empty state, error state, narrow viewport).
5. Watch for regressions in adjacent features.
6. Take a screenshot if it's a visual change. Read the screenshot with `read_file` to confirm the render looks right.

If you can't open a browser (sandboxed environment, no display), say so. Don't claim a UI change works because the types compile.

### Build/config change

1. Run the build: `pnpm build`, `npm run build`, `cargo build --release`.
2. If the change affects packaging, install the built artifact locally and run it.
3. Check `.gitignore` and the package's `files` field if you added new generated outputs.

### Migration / schema change

1. Run the migration forward on a test database.
2. Run it backward (if reversible).
3. Confirm the data shape matches what the application code expects.
4. Never run a migration against a real database without explicit user permission.

## When verification fails

Report the failure with the relevant output. Don't:

- Summarize "tests pass" when one failed.
- Silently disable the failing test.
- Loosen the assertion to make it pass.
- Add a `try`/`catch` around the failure.
- Mark the task complete and move on.

Do:

- Show the user the failing output.
- Diagnose: read the error, check your assumptions.
- Either fix the bug, or — if the test reflects an outdated expectation — flag that the test needs updating and ask before changing it.

## When you can't verify

Sometimes you genuinely can't:

- Local environment lacks the runtime (no Python, no GPU).
- The change requires production credentials.
- The change only manifests under load.
- The user is on a different OS than your sandbox.

In those cases: write the change carefully, explain what verification is needed and why you can't do it yourself, and hand off cleanly. "I can't run the iOS simulator from here. Please run `xcrun simctl ... ` and confirm the splash screen renders."

That's a useful report. "Done!" without verification is not.
