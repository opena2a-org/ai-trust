/**
 * Tests for dependency file parsers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectEcosystem, parseDependencyFile } from "./parser.js";
import * as fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

vi.mock("node:fs/promises");

const mockReadFile = vi.mocked(fs.readFile);

describe("parseDependencyFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("package.json parsing", () => {
    it("extracts dependencies and devDependencies", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { chalk: "^5.3.0", commander: "^12.1.0" },
          devDependencies: { typescript: "^5.3.0" },
        })
      );

      const result = await parseDependencyFile("/fake/package.json");

      expect(result).toEqual([
        { name: "chalk" },
        { name: "commander" },
        { name: "typescript" },
      ]);
    });

    it("deduplicates packages appearing in both dependency sections", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { chalk: "^5.0.0" },
          devDependencies: { chalk: "^5.3.0", vitest: "^1.0.0" },
        })
      );

      const result = await parseDependencyFile("/fake/package.json");

      expect(result).toEqual([{ name: "chalk" }, { name: "vitest" }]);
    });

    it("returns empty array when no dependencies exist", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: "empty-pkg" }));

      const result = await parseDependencyFile("/fake/package.json");

      expect(result).toEqual([]);
    });

    it("handles package.json with only devDependencies", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } })
      );

      const result = await parseDependencyFile("/fake/package.json");

      expect(result).toEqual([{ name: "vitest" }]);
    });

    it("throws on invalid JSON", async () => {
      mockReadFile.mockResolvedValue("not valid json{{{");

      await expect(
        parseDependencyFile("/fake/package.json")
      ).rejects.toThrow();
    });

    it("wraps a malformed-JSON error with the file name and an actionable fix", async () => {
      mockReadFile.mockResolvedValue("{ bad json");

      // Not the bare parser string — names the file and gives a concrete fix
      // (release-test P3).
      await expect(
        parseDependencyFile("/fake/package.json")
      ).rejects.toThrow(/package\.json is not valid JSON.*Validate it with/s);
    });

    it("refuses a dependencies value that is a string instead of reading its indices as names", async () => {
      // Object.keys("oops") is ["0", "1", "2", "3"].
      mockReadFile.mockResolvedValue(JSON.stringify({ name: "x", dependencies: "oops" }));

      await expect(parseDependencyFile("/fake/package.json")).rejects.toThrow(
        'package.json is not a dependency file: "dependencies" is a string, not an object of package names. Fix it, then re-run.'
      );
    });

    it.each([
      [{ dependencies: ["a"] }, '"dependencies" is an array'],
      [{ dependencies: true }, '"dependencies" is a boolean'],
      [{ dependencies: "" }, '"dependencies" is a string'],
      [{ devDependencies: 3 }, '"devDependencies" is a number'],
      [{ devDependencies: 0 }, '"devDependencies" is a number'],
      [{ dependencies: { chalk: "^5.3.0" }, devDependencies: false }, '"devDependencies" is a boolean'],
    ])("refuses %j, naming the field and the type found", async (manifest, problem) => {
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      await expect(parseDependencyFile("/fake/package.json")).rejects.toThrow(
        `package.json is not a dependency file: ${problem}, not an object of package names. Fix it, then re-run.`
      );
    });

    it.each([
      ["[]", "an array"],
      ['["chalk"]', "an array"],
      ['"oops"', "a string"],
      ["5", "a number"],
      ["true", "a boolean"],
      ["null", "null"],
    ])("refuses a top level of %s, naming the top level", async (content, kind) => {
      mockReadFile.mockResolvedValue(content);

      await expect(parseDependencyFile("/fake/package.json")).rejects.toThrow(
        `package.json is not a dependency file: the top level is ${kind}, not an object. Fix it, then re-run.`
      );
    });

    it("reads a dependencies or devDependencies of null as absent", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ dependencies: null }));
      await expect(parseDependencyFile("/fake/package.json")).resolves.toEqual([]);

      mockReadFile.mockResolvedValue(
        JSON.stringify({ dependencies: { chalk: "^5.3.0" }, devDependencies: null })
      );
      await expect(parseDependencyFile("/fake/package.json")).resolves.toEqual([
        { name: "chalk" },
      ]);
    });

    it("reads the names of dependencies whose version is not a string", async () => {
      // Only the names are read.
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { chalk: 5, commander: null },
          devDependencies: { typescript: { version: "5.3.0" } },
        })
      );

      await expect(parseDependencyFile("/fake/package.json")).resolves.toEqual([
        { name: "chalk" },
        { name: "commander" },
        { name: "typescript" },
      ]);
    });
  });

  describe("requirements.txt parsing", () => {
    it("extracts package names", async () => {
      mockReadFile.mockResolvedValue("flask\nrequests\nnumpy\n");

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
        { name: "numpy", ecosystem: "pypi" },
      ]);
    });

    it("strips version specifiers", async () => {
      mockReadFile.mockResolvedValue(
        "flask==2.3.0\nrequests>=2.28.0\nnumpy~=1.24\n"
      );

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
        { name: "numpy", ecosystem: "pypi" },
      ]);
    });

    it("strips extras brackets", async () => {
      mockReadFile.mockResolvedValue("requests[security]\ncelery[redis,auth]\n");

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([
        { name: "requests", ecosystem: "pypi" },
        { name: "celery", ecosystem: "pypi" },
      ]);
    });

    it("skips comments and empty lines", async () => {
      mockReadFile.mockResolvedValue(
        "# This is a comment\nflask\n\n# Another comment\nrequests\n"
      );

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
      ]);
    });

    it("skips lines starting with dash (flags like -r, -e)", async () => {
      mockReadFile.mockResolvedValue(
        "-r base.txt\n-e git+https://example.com/pkg.git\nflask\n"
      );

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([{ name: "flask", ecosystem: "pypi" }]);
    });

    it("deduplicates repeated packages", async () => {
      mockReadFile.mockResolvedValue("flask\nflask\nrequests\n");

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
      ]);
    });

    it("returns empty array for empty file", async () => {
      mockReadFile.mockResolvedValue("");

      const result = await parseDependencyFile("/fake/requirements.txt");

      expect(result).toEqual([]);
    });
  });

  describe("file names audit reads", () => {
    // The refusal looks at the path on disk, so these files are real; only
    // the read is mocked.
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "ai-trust-parser-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function readFails(code: string): NodeJS.ErrnoException {
      const err = new Error(`${code}: read failed`) as NodeJS.ErrnoException;
      err.code = code;
      mockReadFile.mockRejectedValue(err);
      return err;
    }

    it("refuses README.md before reading it", async () => {
      const readme = path.join(dir, "README.md");
      writeFileSync(readme, "# DVAA\ndocker compose up\n");

      await expect(parseDependencyFile(readme)).rejects.toThrow(
        "audit reads package.json or requirements.txt; README.md is neither."
      );
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it.each(["my-deps.json", "deps.txt", "Depfile", "Gemfile", "notes.txt", "package.json.bak"])(
      "refuses %s before reading it",
      async (name) => {
        const file = path.join(dir, name);
        writeFileSync(file, JSON.stringify({ dependencies: { lodash: "^4.0.0" } }));

        await expect(parseDependencyFile(file)).rejects.toThrow(
          `audit reads package.json or requirements.txt; ${name} is neither.`
        );
        expect(mockReadFile).not.toHaveBeenCalled();
      }
    );

    it("leaves a missing file of another name to the read, which fails with ENOENT", async () => {
      const enoent = readFails("ENOENT");
      const missing = path.join(dir, "README.md");

      await expect(parseDependencyFile(missing)).rejects.toBe(enoent);
      expect(mockReadFile).toHaveBeenCalledWith(missing, "utf-8");
    });

    it("leaves a directory to the read, which fails with EISDIR, instead of refusing it by name", async () => {
      const sub = path.join(dir, "dvaa");
      mkdirSync(sub);
      const eisdir = readFails("EISDIR");

      await expect(parseDependencyFile(`${sub}/`)).rejects.toBe(eisdir);
      expect(mockReadFile).toHaveBeenCalledWith(`${sub}/`, "utf-8");
    });

    it("passes on EISDIR for a directory named package.json", async () => {
      const eisdir = readFails("EISDIR");

      await expect(parseDependencyFile("/fake/package.json")).rejects.toBe(eisdir);
    });

    it("refuses another name that is read because it was not there to refuse", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ dependencies: { lodash: "^4.0.0" } }));

      await expect(parseDependencyFile(path.join(dir, "deps.json"))).rejects.toThrow(
        "audit reads package.json or requirements.txt; deps.json is neither."
      );
    });

    it.each([
      "requirements-dev.txt",
      "requirements_test.txt",
      "requirements",
      "dev-requirements.txt",
      "test-requirements.txt",
      "requirements/dev.txt",
      "requirements/prod.txt",
    ])(
      "reads %s as a requirements file",
      async (name) => {
        mockReadFile.mockResolvedValue("flask==2.3.0\nrequests\n");

        const result = await parseDependencyFile(`/fake/${name}`);

        expect(result).toEqual([
          { name: "flask", ecosystem: "pypi" },
          { name: "requests", ecosystem: "pypi" },
        ]);
      }
    );
  });
});

describe("detectEcosystem", () => {
  it.each([
    ["package.json", "npm"],
    ["requirements.txt", "pypi"],
    ["requirements-dev.txt", "pypi"],
    ["requirements", "pypi"],
    ["dev-requirements.txt", "pypi"],
    ["requirements/dev.txt", "pypi"],
  ] as const)("names %s as %s", (name, ecosystem) => {
    expect(detectEcosystem(`/fake/${name}`)).toBe(ecosystem);
  });
});
