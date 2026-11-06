import { database } from "./db";
import { HttpError } from "./http";
import {
  defaultReleaseSettings,
  type ResourceReleaseSettings,
} from "./resource-releases";

const SETTINGS_ID = "current";
const publicFields = {
  version: true,
  publishedAt: true,
  changes: true,
  knownIssues: true,
} as const;

function publicSettings(
  value: ResourceReleaseSettings,
): ResourceReleaseSettings {
  return {
    version: value.version,
    publishedAt: value.publishedAt,
    changes: value.changes,
    knownIssues: value.knownIssues,
  };
}

export async function getResourceReleaseSettings(): Promise<ResourceReleaseSettings> {
  const settings = await database().resourceReleaseSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: publicFields,
  });
  return publicSettings(settings ?? defaultReleaseSettings);
}

function text(
  value: unknown,
  label: string,
  maxLength: number,
  required = true,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label}必须是文本`, "INVALID_RELEASE_SETTINGS");
  }
  const result = value.trim();
  if ((required && !result) || result.length > maxLength) {
    throw new HttpError(
      400,
      `${label}${required ? "不能为空，且" : ""}最多 ${maxLength} 个字符`,
      "INVALID_RELEASE_SETTINGS",
    );
  }
  return result;
}

export async function saveResourceReleaseSettings(
  value: unknown,
): Promise<ResourceReleaseSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "发布设置必须是完整的 JSON 对象",
      "INVALID_RELEASE_SETTINGS",
    );
  }
  const body = value as Record<string, unknown>;
  const version = text(body.version, "版本名称", 120);
  const publishedAt = body.publishedAt;
  if (
    typeof publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt) ||
    publishedAt.startsWith("0000-") ||
    !Number.isFinite(Date.parse(`${publishedAt}T00:00:00.000Z`)) ||
    new Date(`${publishedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !==
      publishedAt
  ) {
    throw new HttpError(
      400,
      "发布日期须为真实的日历日期，格式为 YYYY-MM-DD",
      "INVALID_RELEASE_DATE",
    );
  }
  const changes = text(body.changes, "更新内容", 3000);
  const knownIssues = text(body.knownIssues, "已知问题", 1500, false);
  const data = {
    version,
    publishedAt,
    changes,
    knownIssues,
    updatedAt: new Date().toISOString(),
  };
  const settings = await database().resourceReleaseSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
    select: publicFields,
  });
  return publicSettings(settings);
}
