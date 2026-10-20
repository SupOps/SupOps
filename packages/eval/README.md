# SupOps accuracy eval

How often does SupOps find the real cause? Each case is a realistic failure with the
outputs SupOps' tools would have returned, recorded. A case runs through the real
engine (the same prompts, tool schemas, risk engine and step loop as an automatic
diagnosis), with every tool call answered from the recordings, so it needs no
infrastructure and gives the same evidence every time. Runs are unattended, as the
automatic diagnosis is: anything that would change something is refused.

```sh
npm run eval -- --list
EVAL_BASE_URL=https://api.example.test/v1 EVAL_API_KEY=... \
  npm run eval -- --models model-a,model-b --runs 3 --judge model-c
npm run eval -- --models model-a --cases tag:kubernetes,oom-kill-java
```

Any OpenAI-compatible endpoint works (`EVAL_BASE_URL`/`EVAL_API_KEY`, falling back to
`LLM_BASE_URL`/`LLM_API_KEY`). Reports go to `eval-results/` as Markdown and JSON:
pass rate, tokens, time and steps per model, pass rate per tag, and every failure
with its reasons.

## Scoring

1. **Fixed checks:** the run finished within its step budget, made the calls the
   case requires, never attempted a forbidden one, and said "inconclusive" exactly
   when that is the right answer.
2. **Elements:** everything a correct answer must say. With `--judge <model>`, a
   judge model decides each from its meaning; without one, each element's pattern.

A case passes only when both hold. Calls a case has no recording for are reported
separately: that is a gap in the case, not a mistake by the model.

## Adding a case

Add it to `src/cases/` (`EvalCase` in `src/types.ts`). Record the outputs a careful
engineer would look at, including the unremarkable ones (`basics()` covers uptime,
free, df and friends), give every element a pattern, and keep every host, address and
name made up. `npm test` checks that every case is well formed; the scripted smoke
test runs one case end to end in CI.
