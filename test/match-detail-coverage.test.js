import test from "node:test";
import assert from "node:assert/strict";
import { renderDetail } from "../src/matchDetail.js";

const match = { homeTeam: "Home", awayTeam: "Away" };
for (const status of ["IN_PLAY", "PAUSED", "FINISHED", "POSTPONED", "CANCELLED"]) {
  test(`${status}: absent detail does not claim no events, pre-match status or guaranteed recovery`, () => {
    const html = renderDetail({ ...match, status });
    assert.match(html, /Timeline unavailable from the feed/);
    assert.match(html, /Home: Line-up unavailable/);
    assert.match(html, /Away: Line-up unavailable/);
    assert.doesNotMatch(html, /not started|No events|comes back|next data refresh|score stays live/);
  });
}
test("scheduled match explains unpublished line-ups and pre-match timeline", () => {
  const html = renderDetail({ ...match, status: "TIMED" });
  assert.match(html, /match has not started/);
  assert.match(html, /Home: Not published yet/);
});
test("partial detail preserves available players and metadata while explaining the missing team", () => {
  const html = renderDetail({ ...match, status: "FINISHED" }, {
    home: { name: "Home", lineup: [{ name: "Home player", num: 1 }] },
    venue: "Test stadium", referee: "Test referee", degraded: ["events"],
  });
  assert.match(html, /Home player/);
  assert.match(html, /Away: Line-up unavailable/);
  assert.match(html, /Timeline unavailable/);
  assert.match(html, /Test stadium/);
  assert.match(html, /Test referee/);
  assert.match(html, /Some match details are missing/);
});
test("metadata survives an otherwise empty detail payload", () => {
  assert.match(renderDetail(match, { venue: "Empty stadium" }), /Empty stadium/);
});
