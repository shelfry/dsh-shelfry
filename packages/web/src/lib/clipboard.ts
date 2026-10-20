/**
 * 复制文本。
 *
 * navigator.clipboard 只在安全上下文且拿到权限时可用，被拒时用隐藏 textarea
 * + execCommand("copy") 兜底 —— 否则用户点了「复制」会毫无反馈。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 落到下面的兜底 */
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
