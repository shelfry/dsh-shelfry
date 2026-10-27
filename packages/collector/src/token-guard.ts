/**
 * 检索失败的归类：区分「令牌失效」与「临时故障」。
 *
 * 采集器在 auto 模式下遇到检索失败会降级到镜像源，站点仍能出数据，
 * 但这会把令牌过期这类配置问题静默吞掉 —— 数据停止增长而构建依旧成功。
 * 所以鉴权类错误（401/403）必须单独识别出来，交给上层直接失败。
 */

/** GitHub 检索失败时抛出的错误文本形如：`GitHub 检索失败: HTTP 401 {"message":"Bad credentials"…}` */
const AUTH_STATUS = /\bHTTP\s+(?:401|403)\b/;

/**
 * 判断一条检索错误是否属于鉴权问题。
 *
 * 入参 message：错误消息原文。
 * 返回值：命中 401/403 时为 true，表示令牌无效或权限不足。
 */
export function isAuthError(message: string): boolean {
  return AUTH_STATUS.test(message);
}
