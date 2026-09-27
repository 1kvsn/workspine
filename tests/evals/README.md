# Evaluation lanes

`native-brownfield/` is the only Phase 16 claim-producing evaluator. It runs one content-bound,
native Codex brownfield journey and grades final state with a provider-independent oracle.

The older top-level `phase16-*` files and `cases/itsdangerous-*` are preserved historical regression
and forensic evidence. They must not be extended or used for a new relaunch claim.

The evaluator is maintainer tooling under `tests/`; it is not included in the npm package and is not
a Workspine consumer command.

The native journey adds a plain-request case (default `buildPrompts()`; `plainRequest: false` retains the named-lane case): its first prompt names neither a lane nor a skill.
The harness sends owner approval in chat; the agent chooses and records the plan path. The read-only
lane grader snapshots the recorded identity after planning; the approval grader checks state path, identity, owner reference, and approved byte hash before a fresh
session continues. A wrong phase identity fails the approval grade; the incomplete journey retains an invalid seal, never a passing product claim. Freeze new prompts
for each candidate; old frozen prompts do not measure lane discovery. Run provider-free checks with
`node --test tests/evals/native-brownfield/native-brownfield.test.mjs`. No provider run is implied.
