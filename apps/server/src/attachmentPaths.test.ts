import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";

describe("normalizeAttachmentRelativePath", () => {
  it("returns normalized path for valid input", () => {
    expect(normalizeAttachmentRelativePath("thread-1/message-1/file.png")).toBe(
      "thread-1/message-1/file.png",
    );
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeAttachmentRelativePath("thread-1\\message-1\\file.png")).toBe(
      "thread-1/message-1/file.png",
    );
  });

  it("strips leading slashes", () => {
    expect(normalizeAttachmentRelativePath("/thread-1/message-1/file.png")).toBe(
      "thread-1/message-1/file.png",
    );
    expect(normalizeAttachmentRelativePath("///thread-1/message-1/file.png")).toBe(
      "thread-1/message-1/file.png",
    );
  });

  it("strips leading backslashes", () => {
    expect(normalizeAttachmentRelativePath("\\thread-1\\message-1\\file.png")).toBe(
      "thread-1/message-1/file.png",
    );
  });

  it("normalizes path traversal (../)", () => {
    expect(normalizeAttachmentRelativePath("thread-1/../message-1/file.png")).toBe(
      "message-1/file.png",
    );
  });

  it("returns null for path traversal attempts", () => {
    expect(normalizeAttachmentRelativePath("../etc/passwd")).toBeNull();
    expect(normalizeAttachmentRelativePath("thread-1/../../etc/passwd")).toBeNull();
    expect(normalizeAttachmentRelativePath("..%2f..%2fetc/passwd")).toBeNull();
  });

  it("returns null for empty path after normalization", () => {
    expect(normalizeAttachmentRelativePath("")).toBe(".");
    expect(normalizeAttachmentRelativePath("/")).toBeNull();
    expect(normalizeAttachmentRelativePath("///")).toBeNull();
  });

  it("returns null for null bytes", () => {
    expect(normalizeAttachmentRelativePath("thread-1\0message-1/file.png")).toBeNull();
    expect(normalizeAttachmentRelativePath("thread-1/../../etc/passwd\0")).toBeNull();
  });

  it("handles URL-encoded forward slashes in filenames", () => {
    expect(normalizeAttachmentRelativePath("thread-1/message-1/file%2Fname.png")).toBe(
      "thread-1/message-1/file%2Fname.png",
    );
  });

  it("handles spaces in path", () => {
    expect(normalizeAttachmentRelativePath("thread-1/message-1/file name.png")).toBe(
      "thread-1/message-1/file name.png",
    );
  });

  it("handles unicode characters", () => {
    expect(normalizeAttachmentRelativePath("thread-1/消息/file.png")).toBe(
      "thread-1/消息/file.png",
    );
    expect(normalizeAttachmentRelativePath("thread-1/日本語/file.png")).toBe(
      "thread-1/日本語/file.png",
    );
  });
});

describe("resolveAttachmentRelativePath", () => {
  it("resolves valid path within attachments directory", () => {
    const attachmentsDir = "/data/attachments";
    const result = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: "thread-1/message-1/file.png",
    });
    expect(result).toBe(path.join(attachmentsDir, "thread-1/message-1/file.png"));
  });

  it("returns null for path traversal attempt", () => {
    const attachmentsDir = "/data/attachments";
    expect(
      resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: "../../../etc/passwd",
      }),
    ).toBeNull();
  });

  it("handles absolute path attempt (normalized to relative)", () => {
    const attachmentsDir = "/data/attachments";
    const result = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: "/etc/passwd",
    });
    expect(result).toBe("/data/attachments/etc/passwd");
  });

  it("returns null for null byte injection", () => {
    const attachmentsDir = "/data/attachments";
    expect(
      resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: "thread-1\0/../../etc/passwd",
      }),
    ).toBeNull();
  });

  it("returns null for URL-encoded traversal", () => {
    const attachmentsDir = "/data/attachments";
    expect(
      resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: "..%2f..%2f..%2fetc%2fpasswd",
      }),
    ).toBeNull();
  });

  it("prevents directory traversal via backslash on POSIX", () => {
    const attachmentsDir = "/data/attachments";
    expect(
      resolveAttachmentRelativePath({
        attachmentsDir,
        relativePath: "..\\..\\etc\\passwd",
      }),
    ).toBeNull();
  });

  it("normalizes and resolves complex valid paths", () => {
    const attachmentsDir = "/data/attachments";
    const result = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: "thread-1//message-1///file.png",
    });
    expect(result).toBe(path.join(attachmentsDir, "thread-1/message-1/file.png"));
  });

  it("preserves spaces and special characters in filenames", () => {
    const attachmentsDir = "/data/attachments";
    const result = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: "thread-1/folder with spaces/my file (1).png",
    });
    expect(result).toBe(path.join(attachmentsDir, "thread-1/folder with spaces/my file (1).png"));
  });

  it("handles UTF-8 multibyte characters", () => {
    const attachmentsDir = "/data/attachments";
    const result = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: "thread-1/文档/文件.png",
    });
    expect(result).toBe(path.join(attachmentsDir, "thread-1/文档/文件.png"));
  });
});
