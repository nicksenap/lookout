Dispatcher outputs for `test/parse.test.ts`.

- `pi-*.md`: final assistant messages from real local `pi` sessions, trimmed to the
  structure the parser cares about (prose, fenced blocks, their order) and
  de-identified (product names, URLs and internal code removed).
- `contract-*.md`: outputs in lookout's findings contract, written for the tests
  (no lookout dispatch had been run yet when these were made).
