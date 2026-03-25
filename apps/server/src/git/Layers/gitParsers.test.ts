import { describe, expect, it } from "vitest";

import {
  deriveLocalBranchNameFromRemoteRef,
  normalizeRemoteUrl,
  parseBranchAb,
  parseBranchLine,
  parseDefaultBranchFromRemoteHeadRef,
  parseNumstatEntries,
  parsePorcelainPath,
  parseRemoteFetchUrls,
  parseRemoteNames,
  parseRemoteRefWithRemoteNames,
  parseTrackingBranchByUpstreamRef,
  sanitizeRemoteName,
} from "./gitParsers.ts";

// ── parseBranchAb ──

describe("parseBranchAb", () => {
  it("parses valid ahead/behind counts", () => {
    expect(parseBranchAb("+3 -5")).toEqual({ ahead: 3, behind: 5 });
    expect(parseBranchAb("+0 -0")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranchAb("+100 -42")).toEqual({ ahead: 100, behind: 42 });
  });

  it("returns zeros for invalid format", () => {
    expect(parseBranchAb("")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranchAb("garbage")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranchAb("3 -5")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranchAb("+3 5")).toEqual({ ahead: 0, behind: 0 });
  });

  it("returns zeros for partial matches", () => {
    expect(parseBranchAb("+3")).toEqual({ ahead: 0, behind: 0 });
    expect(parseBranchAb("-5")).toEqual({ ahead: 0, behind: 0 });
  });
});

// ── parseNumstatEntries ──

describe("parseNumstatEntries", () => {
  it("parses standard numstat output", () => {
    const stdout = "10\t5\tsrc/app.ts\n3\t1\tsrc/index.ts\n";
    expect(parseNumstatEntries(stdout)).toEqual([
      { path: "src/app.ts", insertions: 10, deletions: 5 },
      { path: "src/index.ts", insertions: 3, deletions: 1 },
    ]);
  });

  it("handles binary files (- for insertions/deletions)", () => {
    const stdout = "-\t-\timage.png\n";
    expect(parseNumstatEntries(stdout)).toEqual([
      { path: "image.png", insertions: 0, deletions: 0 },
    ]);
  });

  it("skips empty lines", () => {
    const stdout = "10\t5\tsrc/app.ts\n\n\n3\t1\tsrc/index.ts\n";
    expect(parseNumstatEntries(stdout)).toHaveLength(2);
  });

  it("handles Windows line endings (CRLF)", () => {
    const stdout = "10\t5\tsrc/app.ts\r\n3\t1\tsrc/index.ts\r\n";
    expect(parseNumstatEntries(stdout)).toEqual([
      { path: "src/app.ts", insertions: 10, deletions: 5 },
      { path: "src/index.ts", insertions: 3, deletions: 1 },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(parseNumstatEntries("")).toEqual([]);
    expect(parseNumstatEntries("\n")).toEqual([]);
    expect(parseNumstatEntries("  \n  \n")).toEqual([]);
  });

  it("handles simple renames (old => new)", () => {
    // Git format: "10\t5\told.ts => new.ts"
    const stdout = "10\t5\told.ts => new.ts\n";
    const result = parseNumstatEntries(stdout);
    expect(result).toEqual([{ path: "new.ts", insertions: 10, deletions: 5 }]);
  });

  it("handles full path renames", () => {
    const stdout = "10\t5\tsrc/old/file.ts => src/new/file.ts\n";
    const result = parseNumstatEntries(stdout);
    expect(result).toEqual([{ path: "src/new/file.ts", insertions: 10, deletions: 5 }]);
  });

  // ── C009 Bug: braced rename syntax ──
  // Git uses braced notation for partial renames: src/{old => new}/file.ts
  // The current implementation slices after " => " producing "new}/file.ts"
  // instead of expanding the braces to "src/new/file.ts".
  it.fails("handles braced rename syntax (C009 bug)", () => {
    // Git numstat format for partial path renames:
    // "10\t5\tsrc/{old => new}/file.ts"
    const stdout = "10\t5\tsrc/{old => new}/file.ts\n";
    const result = parseNumstatEntries(stdout);
    // Expected: braces expanded to full destination path
    expect(result).toEqual([{ path: "src/new/file.ts", insertions: 10, deletions: 5 }]);
  });

  it.fails("handles braced rename at root level (C009 bug)", () => {
    // "{old-name.ts => new-name.ts}" at root
    const stdout = "10\t5\t{old-name.ts => new-name.ts}\n";
    const result = parseNumstatEntries(stdout);
    expect(result).toEqual([{ path: "new-name.ts", insertions: 10, deletions: 5 }]);
  });

  it.fails("handles braced rename with nested directories (C009 bug)", () => {
    // "a/b/{c => d}/e/f.ts"
    const stdout = "3\t1\ta/b/{c => d}/e/f.ts\n";
    const result = parseNumstatEntries(stdout);
    expect(result).toEqual([{ path: "a/b/d/e/f.ts", insertions: 3, deletions: 1 }]);
  });

  it("handles single line with no trailing newline", () => {
    const stdout = "10\t5\tsrc/app.ts";
    expect(parseNumstatEntries(stdout)).toEqual([
      { path: "src/app.ts", insertions: 10, deletions: 5 },
    ]);
  });

  it("handles tab-separated paths (rename with tab in original format)", () => {
    // When git uses two-path format for renames: "10\t5\told\tnew"
    const stdout = "10\t5\told.ts\tnew.ts\n";
    const result = parseNumstatEntries(stdout);
    // With pathParts.length > 1, takes the last part
    expect(result[0]?.path).toBe("new.ts");
  });
});

// ── parsePorcelainPath ──

describe("parsePorcelainPath", () => {
  it("parses untracked files (? prefix)", () => {
    expect(parsePorcelainPath("? src/new-file.ts")).toBe("src/new-file.ts");
    expect(parsePorcelainPath("? README.md")).toBe("README.md");
  });

  it("parses ignored files (! prefix)", () => {
    expect(parsePorcelainPath("! node_modules/package.json")).toBe("node_modules/package.json");
  });

  it("returns null for empty path after prefix", () => {
    expect(parsePorcelainPath("?  ")).toBeNull();
    expect(parsePorcelainPath("? ")).toBeNull();
  });

  it("parses changed files (1 prefix) with tab-separated path", () => {
    // Porcelain v2 format: "1 .M N... 100644 100644 100644 <hash> <hash> <TAB>file"
    const line = "1 .M N... 100644 100644 100644 abc123 def456\tsrc/app.ts";
    expect(parsePorcelainPath(line)).toBe("src/app.ts");
  });

  it("parses renamed files (2 prefix) with tab-separated paths", () => {
    // Porcelain v2 rename: "2 R. N... <modes> <hashes> R100\told\tnew"
    const line = "2 R. N... 100644 100644 100644 abc123 def456 R100\told.ts\tnew.ts";
    expect(parsePorcelainPath(line)).toBe("old.ts");
  });

  it("parses unmerged files (u prefix)", () => {
    const line = "u UU N... 100644 100644 100644 100644 abc123 def456 ghi789\tconflict.ts";
    expect(parsePorcelainPath(line)).toBe("conflict.ts");
  });

  it("returns null for unrecognized line formats", () => {
    expect(parsePorcelainPath("# branch.oid abc123")).toBeNull();
    expect(parsePorcelainPath("")).toBeNull();
    expect(parsePorcelainPath("some random text")).toBeNull();
  });

  it("falls back to last whitespace-separated part when no tab present", () => {
    const line = "1 .M N... 100644 100644 100644 abc123 def456 src/app.ts";
    expect(parsePorcelainPath(line)).toBe("src/app.ts");
  });
});

// ── parseBranchLine ──

describe("parseBranchLine", () => {
  it("parses current branch (asterisk prefix)", () => {
    expect(parseBranchLine("* main")).toEqual({ name: "main", current: true });
    expect(parseBranchLine("* feature/new")).toEqual({ name: "feature/new", current: true });
  });

  it("parses non-current branch", () => {
    expect(parseBranchLine("  develop")).toEqual({ name: "develop", current: false });
    expect(parseBranchLine("  feature/old")).toEqual({ name: "feature/old", current: false });
  });

  it("parses worktree branch (+ prefix)", () => {
    expect(parseBranchLine("+ wt-branch")).toEqual({ name: "wt-branch", current: false });
  });

  it("returns null for empty lines", () => {
    expect(parseBranchLine("")).toBeNull();
    expect(parseBranchLine("   ")).toBeNull();
  });

  it("returns null for symbolic refs", () => {
    expect(parseBranchLine("  origin/HEAD -> origin/main")).toBeNull();
    expect(parseBranchLine("  remotes/origin/HEAD -> origin/main")).toBeNull();
  });

  it("returns null for detached HEAD", () => {
    expect(parseBranchLine("* (HEAD detached at origin/main)")).toBeNull();
    expect(parseBranchLine("* (HEAD detached at abc1234)")).toBeNull();
  });

  it("trims whitespace from branch names", () => {
    expect(parseBranchLine("  main  ")).toEqual({ name: "main", current: false });
  });
});

// ── parseRemoteNames ──

describe("parseRemoteNames", () => {
  it("parses remote names from output", () => {
    const result = parseRemoteNames("origin\nfork\n");
    expect(result).toEqual(["origin", "fork"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseRemoteNames("")).toEqual([]);
    expect(parseRemoteNames("\n")).toEqual([]);
  });

  it("filters out blank lines", () => {
    const result = parseRemoteNames("origin\n\n\nfork\n");
    expect(result).toHaveLength(2);
  });

  it("sorts by descending length", () => {
    const result = parseRemoteNames("ab\nabcde\nabc\n");
    expect(result).toEqual(["abcde", "abc", "ab"]);
  });

  it("trims whitespace from names", () => {
    const result = parseRemoteNames("  origin  \n  fork  \n");
    expect(result).toEqual(["origin", "fork"]);
  });
});

// ── sanitizeRemoteName ──

describe("sanitizeRemoteName", () => {
  it("preserves valid remote names", () => {
    expect(sanitizeRemoteName("origin")).toBe("origin");
    expect(sanitizeRemoteName("my-fork")).toBe("my-fork");
    expect(sanitizeRemoteName("upstream.v2")).toBe("upstream.v2");
    expect(sanitizeRemoteName("user_repo")).toBe("user_repo");
  });

  it("replaces invalid characters with hyphens", () => {
    expect(sanitizeRemoteName("my fork")).toBe("my-fork");
    expect(sanitizeRemoteName("user@repo")).toBe("user-repo");
    expect(sanitizeRemoteName("a/b/c")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeRemoteName("-origin-")).toBe("origin");
    expect(sanitizeRemoteName("---test---")).toBe("test");
  });

  it("returns 'fork' for empty or all-invalid input", () => {
    expect(sanitizeRemoteName("")).toBe("fork");
    expect(sanitizeRemoteName("   ")).toBe("fork");
    expect(sanitizeRemoteName("@@@")).toBe("fork");
  });

  it("trims whitespace before sanitizing", () => {
    expect(sanitizeRemoteName("  origin  ")).toBe("origin");
  });
});

// ── normalizeRemoteUrl ──

describe("normalizeRemoteUrl", () => {
  it("strips trailing slashes and .git suffix", () => {
    expect(normalizeRemoteUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(normalizeRemoteUrl("https://github.com/org/repo/")).toBe(
      "https://github.com/org/repo",
    );
    expect(normalizeRemoteUrl("https://github.com/org/repo.GIT///")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("lowercases the URL", () => {
    expect(normalizeRemoteUrl("HTTPS://GitHub.com/Org/Repo")).toBe("https://github.com/org/repo");
  });

  it("trims whitespace", () => {
    expect(normalizeRemoteUrl("  https://example.com/repo  ")).toBe("https://example.com/repo");
  });
});

// ── parseRemoteFetchUrls ──

describe("parseRemoteFetchUrls", () => {
  it("parses fetch URLs from git remote -v output", () => {
    const stdout = [
      "origin\thttps://github.com/org/repo.git (fetch)",
      "origin\thttps://github.com/org/repo.git (push)",
      "upstream\thttps://github.com/upstream/repo.git (fetch)",
      "upstream\thttps://github.com/upstream/repo.git (push)",
    ].join("\n");
    const result = parseRemoteFetchUrls(stdout);
    expect(result.size).toBe(2);
    expect(result.get("origin")).toBe("https://github.com/org/repo.git");
    expect(result.get("upstream")).toBe("https://github.com/upstream/repo.git");
  });

  it("ignores push-only entries", () => {
    const stdout = "origin\thttps://example.com/repo.git (push)\n";
    expect(parseRemoteFetchUrls(stdout).size).toBe(0);
  });

  it("returns empty map for empty input", () => {
    expect(parseRemoteFetchUrls("").size).toBe(0);
    expect(parseRemoteFetchUrls("\n").size).toBe(0);
  });
});

// ── parseRemoteRefWithRemoteNames ──

describe("parseRemoteRefWithRemoteNames", () => {
  const remotes = ["origin", "upstream"];

  it("parses remote ref into components", () => {
    expect(parseRemoteRefWithRemoteNames("origin/main", remotes)).toEqual({
      remoteRef: "origin/main",
      remoteName: "origin",
      localBranch: "main",
    });
  });

  it("handles nested branch names", () => {
    expect(parseRemoteRefWithRemoteNames("upstream/feature/foo", remotes)).toEqual({
      remoteRef: "upstream/feature/foo",
      remoteName: "upstream",
      localBranch: "feature/foo",
    });
  });

  it("returns null for unrecognized remotes", () => {
    expect(parseRemoteRefWithRemoteNames("fork/main", remotes)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseRemoteRefWithRemoteNames("", remotes)).toBeNull();
    expect(parseRemoteRefWithRemoteNames("  ", remotes)).toBeNull();
  });

  it("returns null when branch name after remote is empty", () => {
    expect(parseRemoteRefWithRemoteNames("origin/", remotes)).toBeNull();
  });
});

// ── parseTrackingBranchByUpstreamRef ──

describe("parseTrackingBranchByUpstreamRef", () => {
  it("finds the branch tracking a given upstream ref", () => {
    const stdout = "main\torigin/main\ndev\torigin/dev\n";
    expect(parseTrackingBranchByUpstreamRef(stdout, "origin/main")).toBe("main");
    expect(parseTrackingBranchByUpstreamRef(stdout, "origin/dev")).toBe("dev");
  });

  it("returns null when no match", () => {
    const stdout = "main\torigin/main\n";
    expect(parseTrackingBranchByUpstreamRef(stdout, "origin/dev")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseTrackingBranchByUpstreamRef("", "origin/main")).toBeNull();
    expect(parseTrackingBranchByUpstreamRef("\n", "origin/main")).toBeNull();
  });
});

// ── deriveLocalBranchNameFromRemoteRef ──

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/main")).toBe("main");
    expect(deriveLocalBranchNameFromRemoteRef("upstream/feature/foo")).toBe("feature/foo");
  });

  it("returns null for invalid refs", () => {
    expect(deriveLocalBranchNameFromRemoteRef("main")).toBeNull();
    expect(deriveLocalBranchNameFromRemoteRef("")).toBeNull();
    expect(deriveLocalBranchNameFromRemoteRef("/main")).toBeNull();
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBeNull();
  });
});

// ── parseDefaultBranchFromRemoteHeadRef ──

describe("parseDefaultBranchFromRemoteHeadRef", () => {
  it("extracts branch name from remote HEAD ref", () => {
    expect(parseDefaultBranchFromRemoteHeadRef("refs/remotes/origin/main", "origin")).toBe("main");
    expect(
      parseDefaultBranchFromRemoteHeadRef("refs/remotes/upstream/develop", "upstream"),
    ).toBe("develop");
  });

  it("returns null for non-matching prefix", () => {
    expect(parseDefaultBranchFromRemoteHeadRef("refs/heads/main", "origin")).toBeNull();
    expect(parseDefaultBranchFromRemoteHeadRef("", "origin")).toBeNull();
  });

  it("returns null for empty branch after prefix", () => {
    expect(parseDefaultBranchFromRemoteHeadRef("refs/remotes/origin/", "origin")).toBeNull();
  });
});
