import { serverConfig } from "./config";
import { database } from "./db";
import { HttpError } from "./http";

const SETTINGS_ID = "site";

export async function getDownloadUrl(): Promise<string> {
  const settings = await database().siteSetting.findUnique({
    where: { id: SETTINGS_ID },
  });
  return settings?.downloadUrl ?? serverConfig().downloadUrl;
}

export async function saveDownloadUrl(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new HttpError(
      400,
      "请输入有效的下载链接（最多 2048 个字符）",
      "INVALID_DOWNLOAD_URL",
    );
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HttpError(
      400,
      "请输入完整的 HTTP(S) 下载链接",
      "INVALID_DOWNLOAD_URL",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (serverConfig().production && url.protocol !== "https:")
  ) {
    throw new HttpError(
      400,
      "下载链接须为 HTTP(S) 地址，不能包含账号密码；生产环境须使用 HTTPS",
      "INVALID_DOWNLOAD_URL",
    );
  }
  const settings = await database().siteSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, downloadUrl: url.href },
    update: { downloadUrl: url.href },
  });
  return settings.downloadUrl;
}
