import { describe, expect, it } from "vitest";
import { serializeAttribute } from "../src/serialize.js";

describe("serializeAttribute", () => {
  it("serializes plain values as JSON", () => {
    expect(serializeAttribute({ a: 1, b: [true, null] }, 1000)).toBe(
      '{"a":1,"b":[true,null]}',
    );
  });

  it("returns strings without JSON quoting", () => {
    expect(serializeAttribute("hello", 1000)).toBe("hello");
  });

  it("redacts sensitive keys at any depth", () => {
    const serialized = serializeAttribute(
      {
        apiKey: "sk-1",
        nested: {
          Authorization: "Bearer abc",
          password: "hunter2",
          ok: "fine",
        },
        list: [{ "x-api-key": "k", session_token: "t" }],
      },
      1000,
    );

    expect(JSON.parse(serialized)).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        password: "[REDACTED]",
        ok: "fine",
      },
      list: [{ "x-api-key": "[REDACTED]", session_token: "[REDACTED]" }],
    });
    expect(serialized).not.toContain("hunter2");
  });

  it("truncates output to the requested length", () => {
    const serialized = serializeAttribute("x".repeat(500), 128);

    expect(serialized.startsWith("x".repeat(128))).toBe(true);
    expect(serialized).toContain("[truncated 372 chars]");
  });

  it("handles circular references", () => {
    const value: Record<string, unknown> = { name: "loop" };
    value.self = value;

    expect(JSON.parse(serializeAttribute(value, 1000))).toEqual({
      name: "loop",
      self: "[Circular]",
    });
  });

  it("limits nesting depth", () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) {
      value = { child: value };
    }

    expect(serializeAttribute(value, 10_000)).toContain("[DepthLimit]");
  });

  it("limits array items and object keys", () => {
    const array = Array.from({ length: 60 }, (_, i) => i);
    const parsedArray = JSON.parse(serializeAttribute(array, 10_000));
    expect(parsedArray).toHaveLength(51);
    expect(parsedArray.at(-1)).toBe("[Array truncated 10 items]");

    const object = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${i}`, i]),
    );
    const parsedObject = JSON.parse(serializeAttribute(object, 10_000));
    expect(Object.keys(parsedObject)).toHaveLength(51);
    expect(parsedObject.__opencode_truncated__).toBe(
      "[Object key limit reached]",
    );
  });

  it("stops traversing once the visit budget is spent", () => {
    // 210 nested arrays against a budget of 128 visits.
    const wide = Array.from({ length: 10 }, () =>
      Array.from({ length: 20 }, () => []),
    );

    expect(serializeAttribute(wide, 768)).toContain("[TraversalLimit]");
  });

  it("converts values JSON cannot represent", () => {
    const serialized = serializeAttribute(
      { big: 10n, fn: () => 1, sym: Symbol("s") },
      1000,
    );

    expect(JSON.parse(serialized)).toEqual({
      big: "10n",
      fn: "[Function]",
      sym: "Symbol(s)",
    });
  });
});
