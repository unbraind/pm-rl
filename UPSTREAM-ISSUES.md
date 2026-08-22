# Upstream issues found while working on pm-rl

These were found by this repo's own work and are recorded here for the orchestrator to file. Nothing below has been filed by this agent.

## `pm comments` rejects the documented `pm comment <id> --message "<text>"` contract

Fleet guidance (including this repository's own agent instructions) documents adding a comment as
`pm comment <id> --author <a> --message "<text>"`. The pinned binary (`./node_modules/.bin/pm`,
2026.8.x) rejects that shape:

```
Error: --message labels a comment mutation but does not provide comment text.
Pass text positionally or with --add, --stdin,...
```

The actual contract is `pm comments <id> --add "<text>"` or `pm comments <id> --stdin`, with
`--message` reserved for annotating the history entry of a mutation. The failure is confusing
because the rejected command *is* the documented one, and the error's remediation names a
different subcommand (`comments`, plural) than the documented verb (`comment`). Either the CLI
should accept `--message` as a content source for a single-comment mutation, or the guidance and
the error should agree on one verb.
