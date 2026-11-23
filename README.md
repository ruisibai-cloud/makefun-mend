# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ruisibai-cloud/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ruisibai-cloud/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies an AI-written edit, in unified diff, SEARCH/REPLACE, V4A (`*** Begin Patch`) or JSON form, to a tree of text files. It detects the format, matches lines at three tiers of fuzziness (exact, trailing whitespace, leading and trailing whitespace with re-indentation), handles creations, deletions and moves, keeps CRLF and final line breaks as the spec requires, and writes nothing at all when any edit in the patch fails. Node 22, standard library only; `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts fix.patch
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y8k7hg2d&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
