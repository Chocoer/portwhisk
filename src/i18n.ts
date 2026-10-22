import { getPreferenceValues } from "@raycast/api";

/** 两种语言共用宿主偏好；缺省或未知值统一使用英文，不触碰连接与凭据。 */
export function t(zh: string, en: string): string {
  return getPreferenceValues<{ language?: string }>().language === "zh-CN" ? zh : en;
}
