import Link from "next/link";
import "./help.css";

const sections = [
  { id: "start", label: "快速开始" },
  { id: "ask", label: "智能问答" },
  { id: "knowledge", label: "知识库使用" },
  { id: "permission", label: "权限与角色" },
  { id: "evidence", label: "来源与预览" },
  { id: "trouble", label: "问题排查" },
];

function Arrow() {
  return <span className="help-arrow" aria-hidden="true">→</span>;
}

export default function HelpPage() {
  return (
    <main className="help-page">
      <header className="help-nav">
          <Link className="help-brand" href="/" aria-label="返回 GBrain 首页">
          <span className="help-brand-mark">G</span>
          <span><strong>GBrain</strong><small>企业级知识库</small></span>
          </Link>
        <nav className="help-nav-links" aria-label="帮助目录">
          {sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.label}</a>)}
        </nav>
        <Link className="help-back" href="/"><Arrow /> 返回系统</Link>
      </header>

      <section className="help-hero">
        <div className="help-hero-copy">
          <p className="help-kicker">G B R A I N  ·  使用指南</p>
          <h1>把知识变成<br /><em>可用的答案。</em></h1>
          <p className="help-lead">从上传一份制度文件，到带着原文依据得到答案，这里带你走完 GBrain 的完整使用路径。</p>
          <div className="help-hero-actions"><a className="help-primary" href="#start">开始使用 <Arrow /></a><a className="help-text-link" href="#trouble">遇到问题？</a></div>
        </div>
        <div className="help-hero-visual" aria-label="知识入库到可信问答的流程示意图">
          <div className="orbit orbit-a" /><div className="orbit orbit-b" />
          <div className="help-node node-main"><span>G</span><b>你的知识</b><small>可检索 · 可追溯</small></div>
          <div className="help-node node-doc"><span>▤</span><b>制度文件</b><small>结构化解析</small></div>
          <div className="help-node node-answer"><span>✦</span><b>可信回答</b><small>附来源依据</small></div>
          <div className="help-line line-a" /><div className="help-line line-b" />
        </div>
      </section>

      <div className="help-layout">
        <aside className="help-side-index"><div className="side-caption">本页内容</div>{sections.map((section, index) => <a key={section.id} href={`#${section.id}`}><span>0{index + 1}</span>{section.label}</a>)}<div className="side-tip"><b>小提示</b><p>按 <kbd>?</kbd> 可打开快捷键帮助，按 <kbd>⌘K</kbd>（Windows 使用 Ctrl+K）可搜索页面和知识。</p></div></aside>

        <div className="help-content">
          <section id="start" className="help-section">
            <div className="section-label">01 / 快速开始</div><h2>三步，开始使用你的知识库</h2><p className="section-intro">登录后，先确认自己能看到哪些知识库，再从一份真实文档开始。知识只有完成解析和索引后，才会进入问答范围。</p>
            <div className="help-steps"><article><span>01</span><h3>确认范围</h3><p>进入“知识库”，查看个人、组织和行业知识库。库的可见范围由组织关系和授权决定。</p></article><article><span>02</span><h3>上传知识</h3><p>打开有管理权限的知识库，上传 PDF、Word、Markdown、TXT、CSV 或直接新增文本。</p></article><article><span>03</span><h3>开始提问</h3><p>等待状态变为“已发布”，回到“对话”选择检索范围，提出具体问题并查看来源。</p></article></div>
          </section>

          <section id="ask" className="help-section tint-section">
            <div className="section-label">02 / 智能问答</div><h2>让问题进入正确的知识范围</h2><p className="section-intro">GBrain 会结合当前会话上下文改写问题，再执行混合检索、融合、重排和权限校验。历史对话用于理解“它、刚才、这份”等指代，但不会绕过知识权限。</p>
            <div className="feature-grid"><div className="feature-card"><b className="feature-icon">⌕</b><h3>先选检索范围</h3><p>默认使用“我可见的全部”。需要核对某个库时，可以在输入框上方只勾选指定知识库。</p></div><div className="feature-card"><b className="feature-icon">↳</b><h3>连续追问</h3><p>在同一个会话里继续追问，系统会保留前文语境；切换新会话后，需要补充必要背景。</p></div><div className="feature-card"><b className="feature-icon">⌁</b><h3>问完整内容</h3><p>对制度、条款、清单等内容，优先询问“请基于原文完整列出并标注来源”，避免只看摘要。</p></div></div>
            <div className="callout"><strong>推荐提问格式</strong><span>对象 + 任务 + 范围 + 输出要求</span><code>请根据《企业研发管理规范》原文，完整列出全部条款并标注章节来源。</code></div>
          </section>

          <section id="knowledge" className="help-section"><div className="section-label">03 / 知识库使用</div><h2>不同知识库，承担不同职责</h2><p className="section-intro">知识库不是简单的文件夹。它决定了知识的所有权、共享边界和谁可以维护内容。</p><div className="kb-table"><div className="kb-row kb-head"><span>类型</span><span>适合存放</span><span>谁可以维护</span><span>共享规则</span></div><div className="kb-row"><strong>个人库</strong><span>笔记、草稿、个人资料</span><span>创建者本人</span><span>不对外共享</span></div><div className="kb-row"><strong>组织库</strong><span>部门制度、流程、项目知识</span><span>本级及上级组织管理员</span><span>下级可读上级，上级不反向读取下级</span></div><div className="kb-row"><strong>行业库</strong><span>法规、标准、行业方法</span><span>指定的行业库管理员</span><span>创建者保留设置管理员和删除权；阅读可按人、组织、角色动态授权</span></div></div><div className="inline-note"><b>文档状态</b><span>解析中 → 索引中 → 已发布</span><i>只有“已发布”内容会参与问答。</i></div></section>

          <section id="permission" className="help-section tint-section"><div className="section-label">04 / 权限与角色</div><h2>看得见、管得了、改不了，边界清清楚楚</h2><p className="section-intro">菜单和操作按钮会根据当前账号权限显示。即使通过链接访问，服务端仍会再次校验最终权限。</p><div className="permission-grid"><div><h3><span>◉</span> 普通成员</h3><p>阅读自己有权限的知识库、发起问答、查看回答来源和在线预览。不能上传、删除或维护知识。</p></div><div><h3><span>◆</span> 知识库管理员</h3><p>维护被管理的知识库及其中知识。行业库管理员只管理被授权的行业库，不自动获得其他行业库权限。</p></div><div><h3><span>◇</span> 组织管理员</h3><p>管理本组织及下级组织的人员和子组织；不能修改上级组织设置。上级组织管理员可管理下级范围。</p></div><div><h3><span>✦</span> 系统管理员</h3><p>管理全局角色、模型供应商、系统配置和审计。为组织指定管理员时，应遵循组织管理范围。</p></div></div></section>

          <section id="evidence" className="help-section"><div className="section-label">05 / 来源与预览</div><h2>每个答案，都能回到原文</h2><p className="section-intro">回答中的引用标记和来源卡片不是装饰，而是核验答案的入口。点击来源即可在线查看原始文件或解析后的内容。</p><div className="evidence-flow"><div><span>回答</span><b>“研发流程分为……”</b></div><Arrow /><div><span>来源 [1]</span><b>企业研发管理规范.docx</b></div><Arrow /><div><span>在线预览</span><b>定位到章节和原文</b></div></div><p className="muted-note">如果来源为空或文档仍处于解析失败状态，请先在知识库管理界面检查状态、重试解析，并确认自己拥有该库的阅读权限。</p></section>

          <section id="trouble" className="help-section tint-section"><div className="section-label">06 / 问题排查</div><h2>常见问题，先看这里</h2><div className="faq-list"><details open><summary>上传后显示“解析失败”怎么办？</summary><p>检查文件是否损坏、格式是否受支持、文件名和大小是否符合限制；在知识库管理界面重试解析。解析成功并完成索引后，状态才会变为“已发布”。</p></details><details><summary>文件已发布，但问答找不到内容？</summary><p>确认当前会话的检索范围包含该知识库；再确认账号仍有阅读权限。对全文问题建议明确要求“基于原文完整回答并列出来源”，并检查文档是否被正确解析。</p></details><details><summary>为什么看不到某个菜单或按钮？</summary><p>平台按权限动态隐藏菜单和操作。组织管理员、行业库管理员和系统管理员的管理范围不同；看不到通常意味着当前账号没有对应能力或不在目标组织/知识库的授权范围内。</p></details><details><summary>为什么能阅读但不能上传或删除？</summary><p>阅读和维护是两种不同权限。只有知识库管理权限才能上传、删除或维护知识；个人库由本人维护，行业库的删除还受创建者规则约束。</p></details></div></section>

          <footer className="help-footer"><div><span className="help-brand-mark">G</span><strong>GBrain</strong></div><p>知识可治理，回答可追溯。</p><Link href="/">返回系统 <Arrow /></Link></footer>
        </div>
      </div>
    </main>
  );
}
