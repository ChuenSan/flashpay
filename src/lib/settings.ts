import { serverConfig } from "./config";
import { database } from "./db";
import { HttpError } from "./http";

const SETTINGS_ID = "site";

export type DownloadSettings = { downloadUrl: string; archivePassword: string };

export async function getDownloadSettings(): Promise<DownloadSettings> {
  const settings = await database().siteSetting.findUnique({
    where: { id: SETTINGS_ID },
  });
  return {
    downloadUrl: settings?.downloadUrl ?? serverConfig().downloadUrl,
    archivePassword: settings?.archivePassword ?? "",
  };
}

export async function saveDownloadSettings(
  value: unknown,
  archivePassword: unknown,
): Promise<DownloadSettings> {
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
  if (
    archivePassword !== undefined &&
    (typeof archivePassword !== "string" || archivePassword.length > 1024)
  ) {
    throw new HttpError(
      400,
      "压缩包密码须为文本，最多 1024 个字符；无密码可留空",
      "INVALID_ARCHIVE_PASSWORD",
    );
  }
  const data = {
    downloadUrl: url.href,
    ...(typeof archivePassword === "string" ? { archivePassword } : {}),
  };
  const settings = await database().siteSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
  });
  return {
    downloadUrl: settings.downloadUrl,
    archivePassword: settings.archivePassword,
  };
}
