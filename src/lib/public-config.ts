// Safe to import into client components. Never add server credentials or download URLs.
export const publicConfig = {
  siteName: "Flashpay",
  resourceName: "刷机资源包",
  resourceDescription: "自主赞助确认后，获取当前资源下载入口。",
  compatibility: "适用机型请先以演示说明核对。",
  demoUrl: "https://www.bilibili.com/video/BV1FAxe68Ehe",
  amounts: [500, 1000, 2000, 5000],
  qrPath: "/payment/wechat-receive-qr.png",
};
