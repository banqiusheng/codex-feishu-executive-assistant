import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const skill = readFileSync(
  join(repositoryRoot, "skills", "executive-assistant", "SKILL.md"),
  "utf8",
);
const runtime = readFileSync(
  join(repositoryRoot, "packages", "runtime", "src", "runtime.ts"),
  "utf8",
);

function jsonExamples(): string {
  return [...skill.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .join("\n");
}

describe("direct Feishu actions skill contract", () => {
  it("points the runner at the current capability table instead of a stale count", () => {
    expect(runtime).toContain("按该 Skill 的当前 capability 表");
    expect(runtime).not.toContain("五项 stdin JSON 合同");
  });

  it("routes reads and direct writes through the fixed typed capabilities", () => {
    for (const capability of [
      "contact.resolve",
      "base.resolve",
      "base.schema.read",
      "base.records.read",
      "base.data.query",
    ]) {
      expect(skill).toMatch(
        new RegExp(
          `"kind": "read",[\\s\\S]{0,100}"capability": "${capability.replace(".", "\\.")}"`,
        ),
      );
    }
    for (const capability of [
      "calendar.create.direct",
      "notification.send.direct",
      "document.report.create",
    ]) {
      expect(skill).toMatch(
        new RegExp(
          `"kind": "execute",[\\s\\S]{0,100}"capability": "${capability.replace(".", "\\.")}"`,
        ),
      );
    }
  });

  it("keeps provider identifiers, free-form documents, cards, and CLI routes out of model payloads", () => {
    const examples = jsonExamples();
    expect(examples).not.toMatch(
      /"(?:recipientOpenId|openId|baseToken|tableId|fieldId|viewId|parentToken|xml|markdown|cardJson|identity|route)"\s*:/i,
    );
    expect(skill).not.toContain("raw XML");
    expect(skill).not.toContain("自定义卡片 JSON");
  });

  it("asks only for missing or ambiguous information and never re-confirms a complete direct request", () => {
    expect(skill).toContain("只追问缺失或有歧义的信息");
    expect(skill).toContain("信息补齐后立即执行，不再询问是否执行");
    expect(skill).toContain("省略结束时间时固定按一小时处理");
    expect(skill).toContain("全部人员解析完成前零发送");
  });

  it("uses task-bound verbatim and attachment references without rewriting or leaking paths", () => {
    expect(skill).toContain('"wording": "verbatim"');
    expect(skill).toContain('"verbatimSourceRef"');
    expect(skill).toContain('"attachmentRefs"');
    expect(skill).toContain("逐字内容不得润色、摘要或改写");
    expect(skill).toContain("只能使用 `<task_resources>`");
    expect(skill).not.toContain("逐字转发和附件转发尚未开放");
  });

  it("creates a native Feishu document only from Base evidence and reports completeness", () => {
    expect(skill).toContain('"capability": "document.report.create"');
    expect(skill).toContain('"evidenceRefs"');
    expect(skill).toContain("飞书云文档链接");
    expect(skill).toContain("不完整或已截断");
    expect(skill).toContain("不得用 Markdown、PDF 或 PPT 冒充");
    expect(skill).not.toContain("尚未包含飞书云文档创建");
  });

  it("delegates PPT work only to visual-first-ppt", () => {
    expect(skill).toContain("$visual-first-ppt");
    expect(skill).toContain("不得在本 Skill 中复制");
  });
});
