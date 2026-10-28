# Glossary

**Change set** — everything lookout is reviewing: the diff between a base and a head, plus the author's intent (PR title and body) when there is one.

**Edit block** — one contiguous run of added or removed lines. The smallest unit lookout reasons about. A git hunk may contain several edit blocks.

**Hunk** — git's unit of diff: edit blocks plus surrounding context. Kept for showing code; not a unit of judgment.

**Card** — one logical change, described in a paragraph, made of edit blocks from any files. The unit a human reviews. Two fixed cards exist: *verified clean* and *untouched*.

**Attention** — how much a single edit block deserves a look: `inert`, `routine`, `needs-eyes`, `suspicious`. Only rules may call something inert.

**Color** — a card's risk: red (needs a human), amber (worth a look), green (fine), grey (verified clean).

**Verdict** — the change set's risk tier (`low`, `medium`, `high`) and how many humans must review it (0, 1 or 2), with reasons.

**Area** — a named set of sensitive paths in a repo's policy (e.g. `auth`, `billing`). Used for floors on color and tier, and for the *untouched* card.

**Claim** — one checkable statement the author makes about the change: a `- ` bullet of the PR body, or the `Door:` / `Blast Radius:` line of a `/pr` body. Grounded as `supported`, `contradicted` or `not-in-diff`; `unclear` when the model's confidence is below the gate (0.7 for contradicted, 0.4 otherwise).

**Unmentioned** — a card no claim points to: the change does something the author did not describe.

**Finding** — a specific problem in the code, with a severity (`p0`, `p1`, `p2`) and ideally an anchor. Starts `proposed`; a verifier marks it `confirmed`, `rejected` or `unsure`.

**Verified** — a finding confirmed by a verifier with evidence (a repro, a reachability argument, or a test). Not the same as two agents agreeing.

**Pre-existing** — a finding about code the change did not touch.

**Proposer / verifier** — the two agent roles: one proposes findings, the other tries to refute them.

**Question** — a yes/no prompt for the human reviewer, chosen per card from a tier-specific bank.

**Exchange** — a free question the reviewer typed (`/`) about one card or the whole change, and the model's answer written from that scope's edits only. Decisions scores whether the answer is consistent with those edits; below 0.7 the answer is shown *unverified*. Stored on the Review, newest last.

**Progress** — where the pipeline is while cards load: the phase (ranking, splitting, writing) and items done of total. Drawn as a ten-cell bar under the header; cleared on done.

**Door** — whether the change is easy to undo (two-way) or not (one-way). Rules compute it from one-way *signals* in the diff (migration, destructive SQL, data write, removed public export or route, contract change); the author's word is compared, never trusted.

**Blast radius** — what the change can affect: the areas it touches and the *importers*, files in the repo that import a changed file and are not themselves changed.

**Depth** — how much agent work runs: `quick` (none), `standard`, `deep`.
