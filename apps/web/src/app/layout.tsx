import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "百纳知识库",
  description: "百纳知识库 · 编译你的组织大脑",
};

const GOOGLE_FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600&family=Noto+Serif+SC:wght@400;500;600&family=Inter:wght@400;500;600&display=swap";

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
        {/* 字体样式表非阻塞加载（media=print 加载完成后切回 all）：
            内网/跨境不可达时不再阻塞首屏渲染，display=swap 保证回退字体先行。 */}
        <link rel="preload" as="style" href={GOOGLE_FONTS_HREF} />
        <link
          rel="stylesheet"
          href={GOOGLE_FONTS_HREF}
          media="print"
          // @ts-expect-error string onload is valid in JSX for HTML attributes
          onLoad="this.media='all'"
        />
        <noscript>
          <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
        </noscript>
      </head>
      <body>
        <div id="root">
          {children}
        </div>
      </body>
    </html>
  );
}
