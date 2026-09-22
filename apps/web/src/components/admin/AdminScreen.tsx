"use client";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Icon } from '@/components/common/Icon';
import { PaginationBar } from '@/components/common/PaginationBar';
import { UsersPanel } from '@/components/admin/UsersPanel';
import { RolesPanel } from '@/components/admin/RolesPanel';
import { IndustryKBPanel } from '@/components/admin/IndustryKBPanel';
import { ModelPanel } from '@/components/admin/ModelPanel';
import { ReprocessPanel } from '@/components/admin/ReprocessPanel';
import { SystemStatusPanel } from '@/components/admin/SystemStatusPanel';
import { DreamTelemetryPanel } from '@/components/admin/DreamTelemetryPanel';
import { GrantPanel, OrgPanel, OrgAdminModal, AddOrgModal, RenameOrgModal, EditOrgModal, DeleteOrgModal } from '@/components/admin/OrgPanel';
import type { DreamTelemetry } from '@/components/admin/DreamTelemetryPanel';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast } from '@/lib/app-events';
import { hasCapability, canAccessAdmin } from '@/lib/capabilities';
import { flattenOrgTree } from '@/lib/org-utils';
import type { AuditRow, IndustryKbRow, OrgTreeNode, Pagination } from '@/types';

export function AdminScreen({onOpenGrant, onManageKb, initialTab, capabilities = []}: { onOpenGrant?: (kbId: string) => void; onManageKb?: (kbId: string) => void; initialTab?: string; capabilities?: string[] }){
  const [tab, setTab] = useState(initialTab || 'org');
  const [auditMeta, setAuditMeta] = useState(appStore.AUDIT_META);
  useEffect(()=>{
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  useEffect(() => setAuditMeta(appStore.AUDIT_META), [appStore.AUDIT.length, appStore.AUDIT_META.total, appStore.AUDIT_META.page]);
  // Dream 遥测(~800KB)已从启动载荷剥离；首次进入审计页时按需拉取
  const dreamLazyRef = useRef(false);
  useEffect(() => {
    if (tab === 'audit' && !appStore.DREAM && capabilities.includes('*') && !dreamLazyRef.current) {
      dreamLazyRef.current = true;
      void loadAuditPage(1);
    }
  }, [tab]);
  const loadAuditPage = async (page: number) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/data?auditPage=${page}&auditLimit=20&telemetry=1`, { headers: apiHeaders() });      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || '审计日志加载失败');
      appStore.AUDIT = (result.audit || []).map((item: AuditRow) => ({ ...item, when: new Date(item.when).toLocaleString('zh-CN'), what: item.action, actor: item.actor }));
      appStore.AUDIT_META = result.auditPagination || { page, limit: 20, total: appStore.AUDIT.length, totalPages: 1 };
      setAuditMeta(appStore.AUDIT_META);
      if (result.dream) appStore.DREAM = result.dream;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(error) || '审计日志加载失败' }));
    }
  };
  const loadDreamPage = async (page: number) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/data?auditPage=${auditMeta.page || 1}&auditLimit=20&dreamPage=${page}&telemetry=1`, { headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Dream 运行记录加载失败');
      if (result.dream) appStore.DREAM = result.dream;
      setAuditMeta((current) => ({ ...current }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: errorMessage(error) || 'Dream 运行记录加载失败' }));
    }
  };
  const [grantKb, setGrantKb] = useState(()=>appStore.INDUSTRY_KBS[0]?.id || '');
  // 组织树 state：支持无限层级新增与多根组织森林
  const initOrgNode = (n: any): any => ({
    ...n,
    id: n.id || ('on_' + Math.random().toString(36).slice(2, 9)),
    children: (n.children || []).map(initOrgNode),
  });
  const [orgTrees, setOrgTrees] = useState<any[]>(() => {
    const raw = (appStore.ORG_TREES && appStore.ORG_TREES.length > 0) ? appStore.ORG_TREES : (appStore.ORG_TREE ? [appStore.ORG_TREE] : []);
    return raw.map(initOrgNode);
  });
  const orgTree = orgTrees[0] || null;

  useEffect(() => {
    const handleAdminDataUpdated = (e: any) => {
      const trees = e.detail?.orgTrees || (appStore.ORG_TREES && appStore.ORG_TREES.length > 0 ? appStore.ORG_TREES : (appStore.ORG_TREE ? [appStore.ORG_TREE] : []));
      setOrgTrees(trees.map(initOrgNode));
    };
    window.addEventListener('app-admin-data-updated', handleAdminDataUpdated);
    return () => window.removeEventListener('app-admin-data-updated', handleAdminDataUpdated);
  }, []);

  // 展开状态受控（新增子组织后自动展开父节点）
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (n: any) => { if (n?.expanded) s.add(n.id); (n?.children || []).forEach(walk); };
    (orgTrees || []).forEach(walk);
    return s;
  });
  const [adminModal, setAdminModal] = useState<any>(null); // 设置管理员的节点
  const [addModal, setAddModal] = useState<any>(null);     // 新增子组织的父节点
  const [renameModal, setRenameModal] = useState<any>(null); // 重命名组织
  const [editModal, setEditModal] = useState<any>(null);   // 编辑组织
  const [deleteModal, setDeleteModal] = useState<any>(null); // 删除组织
  const orgOptions = useMemo(() => flattenOrgTree(orgTrees), [orgTrees]);
  const canCreateRoot = hasCapability('*', capabilities);
  const tabRules = [
    {k:'org', l:'组织架构', ic:'users', permission:'org.read'},
    {k:'users', l:'人员管理', ic:'user', permission:'org.user.read'},
    {k:'roles', l:'角色管理', ic:'shield', permission:'role.read'},
    // 创建者即使已把内容管理员转交给别人，仍需保留设置管理员和删除库的入口。
    // 资源管理员但没有行业库角色时仍不会因此获得整个管理菜单。
    {k:'industry', l:'行业库管理', ic:'book', permission:'kb.industry.read', alternativePermission:'kb.industry.create'},
    {k:'grant', l:'权限授权', ic:'shield', permission:'kb.industry.grant'},
    {k:'model', l:'模型配置', ic:'model', permission:'system.settings.manage'},
    {k:'reprocess', l:'全库数据重处理', ic:'refresh', permission:'system.settings.manage'},
    {k:'audit', l:'审计日志', ic:'history', permission:'audit.read'},
    {k:'status', l:'系统运行监控', ic:'activity', permission:'audit.read', alternativePermission:'system.settings.read'},
  ];
  const availableTabs = tabRules.filter(item => hasCapability(item.permission, capabilities) || (item.alternativePermission && hasCapability(item.alternativePermission, capabilities))).map(item => item.k);
  useEffect(() => {
    if (availableTabs.length && !availableTabs.includes(tab)) setTab(availableTabs[0]);
  }, [availableTabs.join(','), tab]);

  const toggleNode = (id: string) => setExpandedIds(s => { const ns = new Set(s); ns.has(id) ? ns.delete(id) : ns.add(id); return ns; });

  const addChildOrg = async (parentId: any, name: string, adminUserIds: string[] = []) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name, parentId: parentId || null, adminUserIds }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const created = result.organization;
      if (!created) throw new Error('接口未返回新组织');
      if (parentId) {
        setExpandedIds(s => new Set(s).add(parentId));
        setOrgTrees(trees => {
          const rec = (n: any): any => {
            if (n.id === parentId) {
              return {
                ...n,
                children: [
                  ...(n.children || []),
                  { ...created, admins: adminUserIds.map(id => appStore.USERS.find(u => u.id === id)?.name).filter(Boolean), children: [] }
                ]
              };
            }
            return { ...n, children: (n.children || []).map(rec) };
          };
          return trees.map(rec);
        });
      } else {
        const newRoot = { ...created, admins: adminUserIds.map(id => appStore.USERS.find(u => u.id === id)?.name).filter(Boolean), children: [] };
        setOrgTrees(trees => [...trees, newRoot]);
        appStore.ORG_TREES = [...(appStore.ORG_TREES || []), newRoot];
      }
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织「${created.name}」已保存` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织保存失败：${errorMessage(error) || '请稍后重试'}` }));
      return false;
    }
  };
  const updateOrganization = async (node: any, name: string, parentId: any) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name, parentId: parentId || null }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const updated = result.organization;
      if (!updated) throw new Error('接口未返回更新后的组织');

      setEditModal(null);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织「${updated.name}」已更新` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织更新失败：${errorMessage(error) || '请稍后重试'}` }));
      return false;
    }
  };
  const renameOrganization = async (node: any, newName: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ name: newName }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      const updated = result.organization;
      if (!updated) throw new Error('接口未返回更新后的组织');

      const rewritePaths = (current: any, oldPath: string, nextPath: string): any => ({
        ...current,
        ...(current.id === node.id ? { ...current, ...updated } : {}),
        path: current.path === oldPath ? nextPath : current.path.startsWith(`${oldPath}/`) ? `${nextPath}${current.path.slice(oldPath.length)}` : current.path,
        children: (current.children || []).map((child: any) => rewritePaths(child, oldPath, nextPath)),
      });
      setOrgTrees((trees: any[]) => trees.map((tree: any) => rewritePaths(tree, node.path, updated.path)));
      setRenameModal(null);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织已成功重命名为「${updated.name}」` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `重命名失败：${errorMessage(error) || '请稍后重试'}` }));
      return false;
    }
  };
  const deleteOrganization = async (node: any, cascade: boolean = false) => {
    try {
      const url = `${API_BASE_URL}/api/v1/admin/orgs/${node.id}${cascade ? '?cascade=true' : ''}`;
      const response = await fetch(url, { method: 'DELETE', headers: apiHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `API ${response.status}`);
      setOrgTrees((trees: any[]) => {
        const remove = (current: any): any => {
          if (!current) return null;
          if (current.id === node.id) return null;
          return { ...current, children: (current.children || []).map(remove).filter(Boolean) };
        };
        return trees.map(remove).filter(Boolean);
      });
      appStore.ORG_TREES = (appStore.ORG_TREES || []).filter((t: any) => t.id !== node.id);
      setDeleteModal(null);
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织「${node.name}」已删除` }));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
      return true;
    } catch (error: unknown) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: `组织删除失败：${errorMessage(error) || '请稍后重试'}` }));
      return false;
    }
  };
  const updateOrg = (id: string, updater: any) => setOrgTrees(trees => {
    const walk = (node: any): any => node?.id === id ? updater(node) : ({...node, children:(node.children||[]).map(walk)});
    return trees.map(walk);
  });
  const activateKb = async (node: any) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/knowledge-base/activate`, {method:'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({})});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '激活失败');
      const kb = result.knowledgeBase;
      updateOrg(node.id, (current: OrgTreeNode) => ({...current, kbs:[kb.id], knowledgeBase:kb}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:`「${node.name}」组织库已激活`}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch (error: unknown) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '激活失败'})); }
  };
  const deactivateKb = async (node: any) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/orgs/${node.id}/knowledge-base/deactivate`, {method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '去激活失败');
      updateOrg(node.id, (current: OrgTreeNode) => ({...current, kbs:[], knowledgeBase:null}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:`「${node.name}」组织库已去激活`}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch (error: unknown) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '去激活失败'})); }
  };
  return (
    <div className="admin">
      <div className="admin-side">
        <h5>管理后台</h5>
        <div className="a-nav">
          <div className="nav-section" style={{padding:'8px 12px',margin:0,fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>组织与人员</div>
          {tabRules.slice(0,3).filter(it => hasCapability(it.permission, capabilities)).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
          <div className="nav-section" style={{padding:'8px 12px',margin:'12px 0 0',fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>知识与权限</div>
          {tabRules.slice(3,5).filter(it => hasCapability(it.permission, capabilities)).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
          <div className="nav-section" style={{padding:'8px 12px',margin:'12px 0 0',fontSize:10,color:'var(--ink-4)',letterSpacing:.6,textTransform:'uppercase',fontWeight:600}}>系统</div>
          {tabRules.slice(5).filter(it => hasCapability(it.permission, capabilities) || (it.alternativePermission && hasCapability(it.alternativePermission, capabilities))).map(it=>(
            <div key={it.k} className={`a-nav-i ${tab===it.k?'active':''}`} onClick={()=>setTab(it.k)}>
              <Icon name={it.ic} size={14} className="a-ic"/>
              <span>{it.l}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="admin-main">
        {tab==='org' && (
          <OrgPanel
            orgTrees={orgTrees}
            orgTree={orgTree}
            expandedIds={expandedIds}
            onToggle={toggleNode}
            setExpandedIds={setExpandedIds}
            onAddChild={(n: any)=>setAddModal(n)}
            onSetAdmin={(n: any)=>setAdminModal(n)}
            onRename={(n: any)=>setRenameModal(n)}
            onEdit={(n: any)=>setEditModal(n)}
            onDelete={(n: any)=>setDeleteModal(n)}
            onActivateKb={activateKb}
            onDeactivateKb={deactivateKb}
            onManageKb={onManageKb}
            canCreateRoot={canCreateRoot}
          />
        )}
        {tab==='users' && <UsersPanel orgTrees={orgTrees} orgTree={orgTree} orgOptions={orgOptions} canManage={hasCapability('org.user.manage', capabilities)} capabilities={capabilities}/>}
        {tab==='roles' && <RolesPanel canManage={hasCapability('role.manage', capabilities)}/>}
        {tab==='industry' && <IndustryKBPanel canCreate={hasCapability('kb.industry.create', capabilities)} onOpenGrant={(k)=>{setGrantKb(k.id); setTab('grant');}}/>}
        {tab==='grant' && <GrantPanel kbId={grantKb} setKbId={setGrantKb}/>}
        {tab==='model' && <ModelPanel/>}
        {tab==='reprocess' && <ReprocessPanel/>}
        {tab==='audit' && (
          <>
            <div style={{display:'flex',alignItems:'flex-start',marginBottom:18}}>
              <div style={{flex:1}}>
                <div className="h1">审计日志</div>
                <div className="subline">查询 · 知识变更 · 权限变更 · 大脑编译记录 · Dream Cycle · 越权拦截 · 留存 ≥ 1 年</div>
              </div>
              {Boolean(appStore.DREAM) && capabilities.includes('*') && <button className="btn" onClick={async()=>{
                try {
                  const response = await fetch(`${API_BASE_URL}/api/v1/admin/brain/maintenance`, {method:'POST', headers:apiHeaders()});
                  const result = await response.json().catch(()=>({}));
                  if (!response.ok) throw new Error(result.message || '维护任务提交失败');
                  window.dispatchEvent(new CustomEvent('app-toast',{detail:'Dream Cycle 已进入后台队列'}));
                  window.setTimeout(()=>window.dispatchEvent(new CustomEvent('app-data-refresh')),1500);
                } catch (error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '维护任务提交失败'})); }
              }}><Icon name="refresh" size={12}/> 立即执行维护</button>}
            </div>
            {appStore.DREAM ? <DreamTelemetryPanel telemetry={appStore.DREAM as DreamTelemetry} onPageChange={(page: number) => loadDreamPage(page)}/> : null}
            <div className="audit">
              {appStore.AUDIT.map((a,i)=>(
                <div key={i} className="audit-row">
                  <div className="when">{String(a.when)}</div>
                  <div className="what">{String(a.what)}</div>
                  <div className="actor">{String(a.actor)}</div>
                </div>
              ))}
            </div>
            <PaginationBar pagination={auditMeta} onChange={(page: number) => loadAuditPage(page)} label="条审计记录" />
          </>
        )}
        {tab==='status' && <SystemStatusPanel capabilities={capabilities}/>}

        {adminModal && <OrgAdminModal node={adminModal} onClose={()=>setAdminModal(null)} onSaved={()=>{setAdminModal(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
        {addModal && <AddOrgModal parent={addModal} orgOptions={orgOptions} canCreateRoot={canCreateRoot} onAdd={async (name, parentId, adminUserIds)=>{if (await addChildOrg(parentId, name, adminUserIds)) setAddModal(null);}} onClose={()=>setAddModal(null)}/>}
        {renameModal && <RenameOrgModal node={renameModal} onSave={(newName: string)=>renameOrganization(renameModal, newName)} onClose={()=>setRenameModal(null)}/>}
        {editModal && <EditOrgModal node={editModal} orgOptions={orgOptions} canCreateRoot={canCreateRoot} onSave={(name, parentId)=>updateOrganization(editModal, name, parentId)} onClose={()=>setEditModal(null)}/>}
        {deleteModal && <DeleteOrgModal node={deleteModal} onDelete={(node: any, cascade: boolean)=>deleteOrganization(node, cascade)} onClose={()=>setDeleteModal(null)}/>}
      </div>
    </div>
  );
}
