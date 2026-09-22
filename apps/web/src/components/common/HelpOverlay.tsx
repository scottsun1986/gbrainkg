import React, { useState } from 'react';

export interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const [activeTab, setActiveTab] = useState<'manual' | 'shortcuts'>('manual');

  if (!open) return null;

  const groups = [
    { label: '全局导航', items: [
      { keys: ['⌘', 'K'], label: '打开全局命令搜索面板' },
      { keys: ['⌘', '1'], label: '快速切换到「智能问答」' },
      { keys: ['⌘', '2'], label: '快速切换到「知识管理」' },
      { keys: ['⌘', '3'], label: '快速切换到「知识图谱」' },
      { keys: ['⌘', '4'], label: '快速切换到「管理后台」' },
    ] },
    { label: '快捷操作', items: [
      { keys: ['⌘', 'N'], label: '新建对话会话' },
      { keys: ['⌘', 'F'], label: '聚焦当前搜索框' },
      { keys: ['⌘', '\\'], label: '展开 / 折叠左侧栏' },
      { keys: ['?'], label: '打开本使用帮助' },
      { keys: ['Esc'], label: '关闭弹窗 / 取消选区' },
    ] },
    { label: '图谱交互', items: [
      { keys: ['滚轮'], label: '以光标为中心缩放画布' },
      { keys: ['拖拽空白'], label: '平移知识图谱' },
      { keys: ['拖拽节点'], label: '调整物理力导向布局' },
      { keys: ['单击节点'], label: '侧栏查看节点属性与关联' },
      { keys: ['双击节点'], label: '直达关联文档与源库' },
    ] },
    { label: '智能对话', items: [
      { keys: ['Enter'], label: '发送问答消息' },
      { keys: ['Shift', 'Enter'], label: '在提问框内换行' },
    ] },
  ];

  const manualSections = [
    {
      title: '一、 知识库体系与三级权限架构',
      desc: '平台采用严密的 RBAC + 组织树继承 + Pre-filter ACL 隔离体系：',
      points: [
        '【个人知识库】：仅创建者本人可见与维护，用于存放个人笔记、研究草稿与敏感材料。',
        '【组织知识库】：绑定企业组织架构节点（如合规部、研发中心），自动面向部门及子部门成员开放权限。',
        '【行业标准库】：跨组织共享的公共法规与权威标准库，由管理员统一维护并授予指定主体访问。'
      ]
    },
    {
      title: '二、 文档入库、版面解析与父子分块',
      desc: '支持 PDF、Word (.doc/.docx)、Markdown、TXT、CSV 等多种格式：',
      points: [
        '【版面还原解析】：自动调用 Docling 高性能微服务提取表格与多栏排版，无损转换为 Markdown。',
        '【智能父子分块】：采用 1800 字符细粒度检索块并注入章节完整 Context，杜绝条款断章取义。',
        '【异步状态流转】：上传后依次经历 parsing (解析中) -> indexing (索引中) -> published (已发布)。'
      ]
    },
    {
      title: '三、 智能问答与可信证据链溯源',
      desc: '基于编译式大脑 (Compile-then-Query) 引擎，提供金融/法律级真实性保障：',
      points: [
        '【检索范围选择】：可在输入框上方自由指定「我可见的全部」或勾选特定知识库范围。',
        '【流式推理问答】：支持 DeepSeek / 本地大模型实时打字机生成，并自动标注引用角标 [1][2]。',
        '【精准引用卡片】：点击回答下方的证据卡片，可直接高亮定位到原始文档切片与章节出处。'
      ]
    },
    {
      title: '四、 知识图谱物理网络探索',
      desc: '直观呈现企业知识资产的全景拓扑关系：',
      points: [
        '【自动实体提取】：基于文档标题、Markdown 关联与显式引用，动态构建概念网络。',
        '【多维关系筛选】：支持高亮展示 contains (包含)、mentions (提及)、related_to (关联) 关系。'
      ]
    },
    {
      title: '五、 系统管理后台与模型路由',
      desc: '管理员专属运维控制台：',
      points: [
        '【人员与角色配置】：支持用户增删改查、停用封禁，以及自定义角色权限矩阵。',
        '【组织树管理】：可视化维护部门上下级层级，一键为部门开启专属知识库。',
        '【模型网关配置】：支持动态接入并测试 LLM、Embedding 与 Rerank 供应商，无缝热切换。'
      ]
    }
  ];

  return (
    <div className="cmdk-mask" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="help-overlay" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '780px', width: '90vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="help-head" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>平台帮助与使用指南</h3>
            <a href="/help" target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: 'var(--evidence)', textDecoration: 'none' }}>完整使用指南 ↗</a>
            <div style={{ display: 'flex', background: 'var(--bg-2)', padding: '2px', borderRadius: '6px' }}>
              <button
                type="button"
                onClick={() => setActiveTab('manual')}
                style={{
                  padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                  background: activeTab === 'manual' ? 'var(--surface)' : 'transparent',
                  color: activeTab === 'manual' ? 'var(--ink)' : 'var(--ink-2)',
                  fontWeight: activeTab === 'manual' ? 600 : 400,
                  boxShadow: activeTab === 'manual' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none'
                }}>
                使用手册
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('shortcuts')}
                style={{
                  padding: '4px 12px', fontSize: '12px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                  background: activeTab === 'shortcuts' ? 'var(--surface)' : 'transparent',
                  color: activeTab === 'shortcuts' ? 'var(--ink)' : 'var(--ink-2)',
                  fontWeight: activeTab === 'shortcuts' ? 600 : 400,
                  boxShadow: activeTab === 'shortcuts' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none'
                }}>
                快捷键速查
              </button>
            </div>
          </div>
          <span className="x" onClick={onClose} style={{ cursor: 'pointer', fontSize: '20px' }}>×</span>
        </div>

        <div className="help-body" style={{ overflowY: 'auto', padding: '16px', flex: 1 }}>
          {activeTab === 'manual' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', lineHeight: 1.6 }}>
              {manualSections.map((sec, idx) => (
                <div key={idx} style={{ background: 'var(--surface-2)', padding: '14px 16px', borderRadius: '8px', border: '1px solid var(--border, #e2e8f0)' }}>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: '14px', fontWeight: 600, color: 'var(--primary, #4f46e5)' }}>{sec.title}</h4>
                  <p style={{ margin: '0 0 8px 0', fontSize: '12px', color: 'var(--ink-3)' }}>{sec.desc}</p>
                  <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--ink)' }}>
                    {sec.points.map((pt, pIdx) => (
                      <li key={pIdx} style={{ marginBottom: '4px' }}>{pt}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div>
              {groups.map((g) => (
                <div className="help-group" key={g.label} style={{ marginBottom: '14px' }}>
                  <div className="help-group-label" style={{ fontWeight: 600, fontSize: '12px', color: 'var(--ink-3)', marginBottom: '6px' }}>{g.label}</div>
                  {g.items.map((it, i) => (
                    <div key={i} className="help-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <div className="help-label" style={{ fontSize: '12px' }}>{it.label}</div>
                      <div className="help-keys">{it.keys.map((k, j) => <span className="kbd" key={j} style={{ marginLeft: '4px' }}>{k}</span>)}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
