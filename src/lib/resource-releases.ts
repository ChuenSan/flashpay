// Public release content only: never include download links or archive passwords.
export type ResourceReleaseSettings = {
  version: string;
  publishedAt: string; // YYYY-MM-DD, without timezone conversion
  changes: string;
  knownIssues: string;
};

// Initial release supplied by the owner. Date defaults to the implementation day
// and can be corrected independently in the admin form.
export const defaultReleaseSettings: ResourceReleaseSettings = {
  version: "ios-thyme-功能增强-中文版",
  publishedAt: "2026-11-06",
  changes:
    "支持在 Windows 下一键启动。\n新增充电功能。\n新增亮度调节功能。\n新增相机入口。",
  knownIssues: "相机目前仍无法识别，暂不可正常使用。",
};

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildResourceReleases(settings: ResourceReleaseSettings) {
  return [
    {
      id: "current",
      title: settings.version,
      publishedAt: settings.publishedAt,
      label: "最新版本",
      sections: [
        { title: "新增与改进", items: lines(settings.changes) },
        ...(settings.knownIssues.trim()
          ? [{ title: "已知问题", items: lines(settings.knownIssues) }]
          : []),
      ],
    },
  ];
}
