import { describe, it, expect } from "vitest";

describe("项目基础设施验证", () => {
  it("基础测试链路通畅", () => {
    expect(1 + 1).toBe(2);
  });

  it("Node.js 环境版本符合预期", () => {
    const version = process.version;
    expect(version.startsWith("v")).toBe(true);
  });
});