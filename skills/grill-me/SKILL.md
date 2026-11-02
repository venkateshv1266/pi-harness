---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea until you reach a shared understanding. Use when the user wants to stress-test their thinking, or says "grill me", "grill this plan", "poke holes in this", or any other 'grill' trigger phrase.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round. Then wait for the user's answers before the next round.

## Ask each round with the questionnaire tool

Put the round to the user with the `questionnaire` tool, not as prose. It renders a selectable list **and** a free-text entry, so the user can pick an option or type an answer that isn't listed.

For every frontier question, pass:

- `id` — a unique kebab-case identifier (for example `storage`); the tool requires it.
- `label` — a short name (for example `Storage`), shown in the tab and the result.
- `prompt` — the full question, including context and the choices.
- `options` — 2–4 concrete answers, **recommended answer first**, worded so picking it means "yes, do that".
- `allowOther: true` — always set it, even when the options look exhaustive. It adds the "Type something." entry that opens an inline editor for a custom answer.

Call the tool once per round with the whole frontier:

```json
{
  "questions": [
    {
      "id": "storage",
      "label": "Storage",
      "prompt": "Where should the event stream live?",
      "allowOther": true,
      "options": [
        { "value": "postgres", "label": "Postgres (recommended)", "description": "Transactional with the ledger; simpler ops." },
        { "value": "kafka", "label": "Kafka", "description": "Higher throughput; another system to run." }
      ]
    }
  ]
}
```

The tool blocks until the user answers, then returns each answer as `Label: user selected: 1. Postgres` or `Label: user wrote: <their text>`. A typed answer is as decisive as a selected one: settle that branch and never re-ask it.

If the tool reports the UI is unavailable (non-interactive, print, or RPC mode), fall back to the markdown round format below and wait for a typed reply.

## Fallback round format

Number each question and give your recommended answer. Word each question so "yes" accepts the recommendation.

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
