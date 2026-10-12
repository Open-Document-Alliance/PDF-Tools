# CSV export source preservation

The `extract_to_csv` path now creates a new output with the existing durable
`writeOutputAtomic` transaction. It refuses any existing target, including
source paths, source hardlinks, symlinks, and aliases through symlinked parent
directories. There is no overwrite argument or change to the result schema.
The tool description names the new-file-only policy.

Each source is read with `readBoundedPdfFileSafely` and the established 250 MiB
per-file cap. The export retains canonical path, device/inode, byte length, and
SHA-256 descriptors, not copies of every input. Before publication, under the
output lock, and after activation, streamed source hashing verifies those
descriptors. The CSV itself is independently hashed after activation before
the transaction can report success. Detected source changes roll back the new
CSV. CSV header ordering, all-field quoting, commas, escaped quotes, row counts,
and bounded preview fields are unchanged.

## Validation

Execution environment: container host `ee79c946fd5e`, Linux x86_64, Node
v24.19.0, Vitest v4.1.10. Base: `ac856ca7ff007354568febb0604a3f5cb43f1fd6`.

Command:

```sh
npm test -- test/csv-export-safety.test.js test/csv-roundtrip.test.js test/packager-server-coverage.test.js test/atomic-output.test.js --maxWorkers=1
```

Result: **77 passed**, four test files, zero failures. The 13 new tests cover
two synthetic PDFs through the real MCP server, exact comma/quote CSV bytes,
source path and hardlink aliases, symlink targets and parents, existing CSVs,
a sparse oversized source, activation-time regular-file/hardlink/symlink
collisions, stage failure, source changes after staging, and output-directory
substitution. The existing CSV roundtrip, transactional fault matrix, and both
packagers' import graph checks also pass.

The focused mirror check also passed (one test; 52 unrelated tests filtered):

```sh
npm test -- test/mcp-contract.test.js -t 'keeps every committed share runtime file' --maxWorkers=1
```

## Boundaries

The shared transaction's existing threat model still applies: portable Node
filesystem operations cannot eliminate the final identity-check/pathname-
syscall window against a privileged non-cooperating actor. Source and directory
checks detect observable substitutions, and no-clobber link publication refuses
late destinations. A symlink inserted at activation is preserved; the shared
transaction conservatively reports `ATOMIC_OUTPUT_ROLLBACK_FAILED` and retains
recovery evidence instead of following or deleting that unknown entry. The
regression test verifies the source PDF and symlink remain intact.

No desktop-host or release artifact qualification was performed in this lane.
The parser-isolation change is handled separately. The combined integration
must regenerate tool contract captures for the changed CSV description and
other lanes' intentional contract changes.
