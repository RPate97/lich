import { describe, it, expect } from "vitest";

import {
  MAX_SUGGESTION_DISTANCE,
  findCloseMatches,
  levenshtein,
  suggestProperty,
} from "../../../src/util/levenshtein.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("tcp", "tcp")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("counts single edits", () => {
    // substitution
    expect(levenshtein("tcp", "tcx")).toBe(1);
    // insertion
    expect(levenshtein("tcp", "tcpz")).toBe(1);
    // deletion
    expect(levenshtein("tcpx", "tcp")).toBe(1);
  });

  it("counts compound edits", () => {
    expect(levenshtein("port_open", "tcp")).toBeGreaterThan(3);
    expect(levenshtein("lifeycle", "lifecycle")).toBe(1);
  });

  it("is symmetric", () => {
    expect(levenshtein("abc", "abd")).toBe(levenshtein("abd", "abc"));
    expect(levenshtein("foo", "barbaz")).toBe(levenshtein("barbaz", "foo"));
  });
});

describe("findCloseMatches", () => {
  it("returns an empty list when the candidate pool is empty", () => {
    expect(findCloseMatches("foo", [])).toEqual([]);
  });

  it("returns the closest single match when one is within threshold", () => {
    expect(
      findCloseMatches("auth_tokn", ["auth_token", "another", "unrelated"]),
    ).toEqual(["auth_token"]);
  });

  it("returns ALL tied candidates at the smallest distance", () => {
    const matches = findCloseMatches("cap", ["cat", "cab", "elephant"]);
    expect(matches.sort()).toEqual(["cab", "cat"]);
  });

  it("preserves the order of the input pool for ties", () => {
    expect(findCloseMatches("frog", ["frob", "frof"])).toEqual([
      "frob",
      "frof",
    ]);
  });

  it("returns nothing for genuinely unrelated names", () => {
    expect(
      findCloseMatches("frob", ["services", "owned", "profiles", "env"]),
    ).toEqual([]);
  });

  it("respects the hard distance cap of MAX_SUGGESTION_DISTANCE", () => {
    // 12-char input would allow 4 edits via length scaling; hard cap clamps to 3
    expect(MAX_SUGGESTION_DISTANCE).toBe(3);
    expect(
      findCloseMatches("abcdefghijkl", ["abcdwxyzijkl", "totally-unrelated"]),
    ).toEqual([]);
  });

  it("uses a length-floor of 1 so very short typos still surface", () => {
    // length 3 → threshold 1
    expect(findCloseMatches("tc", ["tcp", "udp"])).toEqual(["tcp"]);
    expect(findCloseMatches("udp", ["tcp"])).toEqual([]);
  });
});

describe("suggestProperty", () => {
  it("returns null when no candidate is close enough", () => {
    expect(suggestProperty("frob", ["services", "owned"])).toBeNull();
  });

  it("returns a single-candidate hint in the spec-defined format", () => {
    expect(
      suggestProperty("host_pot", ["host_port", "container", "env"]),
    ).toBe(' — did you mean "host_port"?');
  });

  it("returns a multi-candidate hint when matches tie at the same distance", () => {
    expect(suggestProperty("cab", ["cat", "cap", "elephant"])).toBe(
      " — did you mean one of: cat, cap?",
    );
  });

  it("does not noise on completely unrelated names", () => {
    expect(
      suggestProperty("frob", ["services", "owned", "profiles", "env"]),
    ).toBeNull();
  });

  it("suggests the closest ready_when key for a single-edit typo", () => {
    expect(
      suggestProperty("log_mtch", ["http_get", "tcp", "log_match", "cmd"]),
    ).toBe(' — did you mean "log_match"?');
  });
});
