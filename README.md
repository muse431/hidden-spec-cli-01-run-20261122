# mend

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads all of them:

- unified diffs (even with wrong line numbers),
- `SEARCH`/`REPLACE` blocks,
- V4A patches (`*** Begin Patch` ... `*** End Patch`),
- text-editor tool calls as JSON (one array, or one edit object per line).

Every file is changed or nothing is: edits apply in patch order, a failed
edit changes nothing, later edits still run and every failure is reported,
and when any edit failed no file is written at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

Old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed (new lines are re-indented to the file's own indentation).

A unified hunk takes the occurrence nearest its (possibly wrong) line
number; a SEARCH/REPLACE block fails as ambiguous when its old lines occur
more than once; a V4A chunk takes the first occurrence at or after its
cursor, optionally anchored to a line or to the end of the file.

## Output

- Exit 2, one line, on a usage error, an unreadable patch file, an
  undetected format, or a patch that cannot be parsed.
- Exit 1, one `error: <code> <path>` line per failed edit and a
  `failed: <k> of <n> edits` line, when edits failed (no file is written).
- Exit 0, one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>`
  for a move) in byte order, then `ok: <n> files`.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the trial runner, as shipped in the kit (do not modify).
- `check.ts` — run the practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the full specification this entry implements.
- `LICENSE` — MIT.

## Practice

The kit's practice set (100 checks) passes in full, and each of the three
practice trials scores 1000:

    node check.ts ../program/generator/practice.json

Deterministic: no clock, no randomness, no model calls — the same patch on
the same tree always produces the same exit code, output and files.
