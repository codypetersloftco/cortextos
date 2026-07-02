// CI-clean test environment.
//
// cortextOS agents run the test suite from a *live agent cwd*, where the
// process inherits CTX_* environment variables (CTX_AGENT_DIR,
// CTX_FRAMEWORK_ROOT, CTX_PROJECT_ROOT, CTX_ROOT, CTX_AGENT_NAME, ...).
// Those leak into tests that resolve project/agent roots or read the live
// enabled-agents.json, producing phantom failures that do NOT reproduce in
// a clean CI checkout. A raw `npm test` from an agent shell reported 53
// failures; 27 of them were pure CTX_* env-leak (bus-crons "CTX_AGENT_DIR
// not under CTX_FRAMEWORK_ROOT", enable-agent-validation reading the real
// fleet roster, hook tests). Scrubbing CTX_* restores the authoritative
// baseline (26 genuine failures at the time of writing).
//
// This runs in every Vitest worker before any test module loads. Tests that
// genuinely need a CTX_* var set it explicitly in their own beforeEach/setup,
// so removing the *inherited* values here only removes contamination.
//
// Refs: path-sep portability audit (task_1781385220945),
//       CI-clean env wrapper (task_1782203840664).

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
