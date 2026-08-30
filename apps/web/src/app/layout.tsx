import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "企业级 GBrain 知识库",
  description: "企业级 GBrain 知识库 · 编译你的组织大脑",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{const t=localStorage.getItem('llmwiki_theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}" }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600&family=Noto+Serif+SC:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div id="root">
          {children}
        </div>
      </body>
    </html>
  );
}
