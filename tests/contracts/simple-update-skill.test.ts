import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const skillPath = join(
  repositoryRoot,
  "skills",
  "executive-assistant",
  "SKILL.md",
);

function updateSection(): string {
  const skill = readFileSync(skillPath, "utf8");
  const marker = "## 版本更新\n";
  const start = skill.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = skill.slice(start + marker.length);
  const nextHeading = remainder.search(/^## /m);
  return nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
}

describe("executive assistant simple update contract", () => {
  it("uses only the two fixed updater invocations", () => {
    const section = updateSection();
    const commands = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      (match) => match[1]?.trim(),
    );

    expect(commands).toEqual([
      '"$ASSISTANT_NODE_PATH" "$ASSISTANT_REPOSITORY_ROOT/scripts/update-assistant.mjs" --check',
      '"$ASSISTANT_NODE_PATH" "$ASSISTANT_REPOSITORY_ROOT/scripts/update-assistant.mjs" --apply',
    ]);
    expect(section).not.toMatch(/\bgit\b|\bcurl\b|\bwget\b|\bpnpm\b/);
  });

  it("checks opportunistically, prompts only when available, and never blocks the task", () => {
    const section = updateSection();

    expect(section).toContain("每次普通任务");
    expect(section).toContain('`status` 精确等于 `"available"`');
    expect(section).toContain("发现新版本，回复“更新”即可安装。");
    expect(section).toContain("检查失败或暂时不可用");
    expect(section).toContain("继续完成总裁原任务");
  });

  it("applies only for the trimmed exact update command", () => {
    const section = updateSection();

    expect(section).toContain("去除首尾空白");
    expect(section).toContain("精确等于“更新”");
    expect(section).toContain("其他任何文字都不是更新授权");
    expect(section).toContain("收到，开始更新，预计需要几分钟。");
  });
});
