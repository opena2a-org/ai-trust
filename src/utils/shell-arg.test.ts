import { describe, it, expect } from "vitest";
import { shellArg } from "./shell-arg.js";

describe("shellArg", () => {
  it.each(["express", "@scope/server-x", "pip:requests", "/home/user/my-app"])(
    "prints %s as it is",
    (value) => {
      expect(shellArg(value)).toBe(value);
    },
  );

  it("quotes a value with shell syntax, so it stays one word", () => {
    expect(shellArg("shell-lib; echo injected")).toBe("'shell-lib; echo injected'");
    expect(shellArg("a $(b) `c` | d")).toBe("'a $(b) `c` | d'");
    expect(shellArg("my dir")).toBe("'my dir'");
  });

  it("closes and reopens the quotes around a single quote", () => {
    expect(shellArg("it's; echo x")).toBe("'it'\\''s; echo x'");
  });
});
