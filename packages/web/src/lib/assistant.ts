/**
 * 复制给编程助手的提示词。
 *
 * 上游安装器常常会写配置、建目录，直接让助手执行风险不可控；
 * 统一带上「先出计划 → 等确认 → 再执行 → 最后验证」四步，避免用户只看到一句命令。
 */
export function assistantPrompt(target: { name: string; repo: string; command: string }): string {
  const lines = [
    `使用 \`${target.command}\` 安装 ${target.name}，并连接到当前编程助手。`,
    "先展示安装计划（会改动哪些文件与配置），等我确认后再执行，最后验证安装结果并告诉我怎么使用。",
    `仓库：https://github.com/${target.repo}`,
  ];
  if (target.command.includes("<profile>")) {
    lines.push("命令里的 <profile> 请先问我用哪个 profile。");
  }
  return lines.join("\n");
}
