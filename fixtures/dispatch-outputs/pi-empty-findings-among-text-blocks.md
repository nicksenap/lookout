`custom-security-scan-instructions` adds the contents of `false-positives.txt` directly to the **primary security-review prompt**.

### Previous flow

```text
Scanner reviews PR
  → generates dependency findings
  → optional filter should remove them
  → filter validation fails, so filtering is skipped
  → findings are commented and block
```

### New flow

```text
false-positives.txt is added to the prompt
  → the scanner is told not to generate dependency/supply-chain findings
  → only code-level findings appear in the output
```

Ideally, its output becomes:

```json
{
  "findings": []
}
```

Because those findings never enter `.findings`:

- no inline comments are created;
- they cannot block the merge.

It remains probabilistic: the model can theoretically ignore the instruction. If that happens, the finding remains and blocks, which is the safer failure mode.
