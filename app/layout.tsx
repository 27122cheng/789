import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Telegram → Pionex 自動交易",
  description: "監控 Telegram 信號並在 Pionex 自動合約交易",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>
        <nav className="topnav">
          <a href="/" className="brand">⚡ TG → Pionex</a>
          <div className="links">
            <a href="/">儀表板</a>
            <a href="/settings">設定</a>
          </div>
        </nav>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
