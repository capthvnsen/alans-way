Run `node scripts/quality-progress.cjs` from the repository to view the local
quality run at http://127.0.0.1:5057. The page refreshes every five seconds.

The experience inventory is in `pieces.json`. Runtime status, screenshots,
comparisons and reports live in ignored `evidence/quality/`, with the page data
in `progress.json`. Evidence links use `/evidence/` relative paths. Keep private
reference-app content local; do not commit screenshots or account information.

Each piece needs a builder, a separate fresh critic, real running output, a
reference comparison, adverse-case checks and relevant regression checks.
Mark a piece accepted only when its evidence supports the specific claim.
Local fixtures are not proof of authenticated remote Hermes execution. Blind
comparisons require genuinely concealed identity and an independent evaluator;
otherwise label them direct comparisons. An overall win remains unproven until
the defined criteria pass.

Freeze a review candidate with `node scripts/quality-snapshot.cjs <unique-label>`.
It copies tracked and unignored source plus generated runtime inputs into ignored
`evidence/quality/snapshots/`, records source hashes, and links the installed
desktop dependencies. Run the critic's Electron checks from that candidate so
later builder edits cannot change the reviewed source. Keep dependencies stable
during review, and serialize tests that require native window focus.

Do not run package, preload-build, dependency-install or other mutating commands
inside a review snapshot. A release/build smoke must use a separate disposable
copy with its own dependencies. Verify snapshot hashes before and after review;
record any accidental mutation and restoration before allowing runtime evidence.
A successful local package or tool-discovery smoke does not establish native GUI,
remote execution, signing/notarization for distribution, or release readiness.

The inventory includes broad areas and smaller checks linked by `parent` IDs.
Acceptance attaches to the exact check and candidate recorded in the evidence;
it does not automatically accept its parent or sibling checks. The metric for
accepted improvements counts distinct reviewed changes, not duplicated rows.
