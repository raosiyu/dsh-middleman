/**
 * 拒绝的形状。
 *
 * 每个拒绝带一个稳定的机器码和一句有界的话，浏览器与模型都能照它行事，
 * 而不是读一段栈。
 *
 * @module dsh-whale-tail/refusals
 */

/** 一个本插件自己决定的拒绝。 */
export class MiddlemanError extends Error {
  /**
   * @param code - 稳定机器码。
   * @param message - 一句有界的话。
   */
  constructor(code, message) {
    super(message)
    this.name = 'MiddlemanError'
    this.code = code
  }
}

/** 是否是本插件的拒绝。 */
export function isMiddlemanError(value) {
  return value instanceof MiddlemanError
}

/** HTTP 状态码。用户能自己修的填 409，找不到的 404，参数问题 400。 */
export function statusForCode(code) {
  switch (code) {
    case 'batch-missing':
    case 'ticket-missing':
      return 404
    case 'invalid-request':
      return 400
    case 'batch-unreadable':
      return 503
    default:
      return 409
  }
}
