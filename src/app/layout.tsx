import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flashpay · 刷机资源交付",
  description:
    "查看资源演示，自主赞助确认后获取刷机资源入口。刷机前请核对机型并备份数据。",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
