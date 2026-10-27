## Benchmark and promotion design

Each connector receives a small human-reviewed fact set rather than a complete golden offering:

```json
{
  "required_datasets": [],
  "supported_form_choices": {},
  "known_field_sets": {},
  "intentionally_omitted_controls": [],
  "behavioral_scenarios": []
}
```

### Standard finding contract

Every validator returns the same bounded structure:

```json
{
  "rule_id": "unknown-form-option",
  "verdict": "fail",
  "severity": "error",
  "offering_path": "offering.options[1]",
  "evidence": [{ "path": "configs/example.json", "locator": "/form/2" }],
  "confidence": "proven"
}
```

Only findings marked `confidence: proven` may become deterministic failures.

### Evaluation artifacts

```text
evals/<eval-id>/
  corpus.json
  scores/<approach>.json
```

Does this benchmark execution and promotion policy look right?
