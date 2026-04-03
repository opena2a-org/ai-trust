/**
 * Tests for dependency file parsers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDependencyFile } from "./parser.js";
import * as fs from "node:fs/promises";
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

  describe("flexible file detection", () => {
    it("parses .json files with non-standard names as package.json", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { express: "^4.0.0" },
        })
      );

      const result = await parseDependencyFile("/fake/my-deps.json");

      expect(result).toEqual([{ name: "express" }]);
    });

    it("parses .txt files as requirements.txt format", async () => {
      mockReadFile.mockResolvedValue("flask==2.3.0\nrequests\n");

      const result = await parseDependencyFile("/fake/deps.txt");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
      ]);
    });

    it("auto-detects JSON content for unknown extensions", async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { lodash: "^4.0.0" },
        })
      );

      const result = await parseDependencyFile("/fake/Depfile");

      expect(result).toEqual([{ name: "lodash" }]);
    });

    it("falls back to requirements.txt parsing for non-JSON unknown extensions", async () => {
      mockReadFile.mockResolvedValue("flask\nrequests\n");

      const result = await parseDependencyFile("/fake/Gemfile");

      expect(result).toEqual([
        { name: "flask", ecosystem: "pypi" },
        { name: "requests", ecosystem: "pypi" },
      ]);
    });
  });
});
