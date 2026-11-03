# daemon/vendor

## pulse-core.cjs

`@heyiris/pulse-core` (iris-opencode `packages/pulse-core`), built as one CommonJS file —
the Heartbeats state model and the Pulse runner that `iris-sdk.js` exposes to scripts as
`iris.heartbeats`, `iris.sources` and `iris.pulse` (#189245).

It is a copy, so it is pinned and checked, not trusted:

- The first line names the package version it was built from.
- `tests/iris-sdk-pulse.test.js` replays the package's own golden fixture
  (`tests/fixtures/pulse-core/golden.json`) against this file. A copy that drifts from the
  package fails there, instead of quietly disagreeing with the Heartbeats panel.

To update: in iris-opencode, `cd packages/pulse-core && bun run build`, then copy
`dist/pulse-core.cjs` here and `test/fixtures/{heartbeats.json,heartbeats.raw.json,golden.json}`
to `tests/fixtures/pulse-core/`, and run `npm test`. Once the package is on npm this becomes a
normal dependency.
