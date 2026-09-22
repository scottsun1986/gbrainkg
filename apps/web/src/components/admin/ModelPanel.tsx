"use client";
import React, { useState } from 'react';
import { Icon } from '@/components/common/Icon';
import { Modal } from '@/components/common/Modal';
import { ConfirmModal } from '@/components/common/ConfirmModal';
import { API_BASE_URL, apiHeaders } from '@/lib/api';
import { appStore } from '@/lib/app-store';
import { errorMessage, apiMessage, asRecord, asArray, str, num, bool } from '@/lib/errors';
import { emitToast, emitDataRefresh } from '@/lib/app-events';
import type { ModelGroups, ModelRow, ProviderRow } from '@/types';

export function ModelPanel(){
  const [sub, setSub] = useState('models');
  const [openNewPv, setOpenNewPv] = useState(false);
  const [editProvider, setEditProvider] = useState<ProviderRow | null>(null);
  const [openNewM, setOpenNewM] = useState<{ kind: string; target: ModelRow | null } | null>(null);
  const [confirmDelPv, setConfirmDelPv] = useState<ProviderRow | null>(null);
  const [confirmDelM, setConfirmDelM] = useState<ModelRow | null>(null);
  const [testStates, setTestStates] = useState<Record<string, string>>({});
  const test = async (id: string) => {
    setTestStates((s: Record<string, string>)=>({...s, [id]:'testing'}));
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/models/${id}/test`,{method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      setTestStates((s: Record<string, string>)=>({...s, [id]:result.status==='passed'?'ok':'failed'}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:result.status==='passed'?'连接测试成功':'连接测试失败'}));
    } catch { setTestStates((s: Record<string, string>)=>({...s, [id]:'failed'})); }
  };
  return (
    <>
      <div style={{display:'flex',alignItems:'flex-start',marginBottom:18}}>
        <div style={{flex:1}}>
          <div className="h1">模型配置</div>
          <div className="subline">供应商注册 → 模型配置 → 测试连接 → 设为默认；切换 Embedding 需重建索引</div>
        </div>
      </div>
      <div className="subtabs">
        <div className={`subtab ${sub==='models'?'active':''}`} onClick={()=>setSub('models')}>模型配置<span className="n">{appStore.MODELS.llm.length+(appStore.MODELS.fast_llm?.length||0)+appStore.MODELS.embedding.length+appStore.MODELS.rerank.length}</span></div>
        <div className={`subtab ${sub==='providers'?'active':''}`} onClick={()=>setSub('providers')}>供应商<span className="n">{appStore.PROVIDERS.length}</span></div>
        <div className={`subtab ${sub==='ocr'?'active':''}`} onClick={()=>setSub('ocr')}>PDF OCR<span className="n">{appStore.PROVIDERS.some(p=>p.kind==='ocr')?'已配置':'未配置'}</span></div>
      </div>

      {sub==='models' && (
        <div className="mc">
          <div className="mc-cat llm">
            <div className="mc-cat-head">
              <span className="tag">LLM · 生成</span>
              <h4>大语言模型</h4>
              <span className="hint">用于答案生成与最终推理</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({ kind:'llm', target: null })}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {appStore.MODELS.llm.map(m=>{
              const state: string = testStates[m.id] || (m.tested?'ok':'idle');
              return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span><span>上下文 {m.ctx}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({ kind:'llm', target:m })}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'llm'})}>删除</button>
                </div>
              );
            })}
          </div>

          <div className="mc-cat fast_llm">
            <div className="mc-cat-head">
              <span className="tag">FAST-LLM · 辅助</span>
              <h4>辅助小模型</h4>
              <span className="hint">用于查询拆解、入库富化、事实蕴含判定与摘要 · 未配置自动回退大语言模型</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({ kind:'fast_llm', target: null })}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {(appStore.MODELS.fast_llm || []).map(m=>{
              const state: string = testStates[m.id] || (m.tested?'ok':'idle');
              return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span><span>上下文 {m.ctx}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({ kind:'fast_llm', target:m })}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'fast_llm'})}>删除</button>
                </div>
              );
            })}
            {(!appStore.MODELS.fast_llm || appStore.MODELS.fast_llm.length === 0) && (
              <div style={{padding:'12px 14px',fontSize:12,color:'var(--ink-3)',background:'var(--surface-2)',borderRadius:8,marginTop:6}}>
                未单独配置辅助小模型，系统将自动复用上方的大语言模型。推荐配置极速轻量模型（如 Qwen-2.5-7B-Instruct / GPT-4o-mini / DeepSeek-Lite）以大幅压降 Token 计费与首字延迟。
              </div>
            )}
          </div>

          <div className="mc-cat embed">
            <div className="mc-cat-head">
              <span className="tag">EMBEDDING · 向量</span>
              <h4>嵌入模型</h4>
              <span className="hint">每库绑定 · 切换需全量重建索引</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({ kind:'embedding', target: null })}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {appStore.MODELS.embedding.map(m=>{
              const state: string = testStates[m.id] || (m.tested?'ok':'idle');
              return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span><span>{m.dim}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({ kind:'embedding', target:m })}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'embedding'})}>删除</button>
                </div>
              );
            })}
            <div className="warn-strip">
              <Icon name="alert" size={12}/>
              切换 Embedding 模型将触发异步全量重建索引，期间查询降级为关键词检索。
            </div>
          </div>

          <div className="mc-cat rerank">
            <div className="mc-cat-head">
              <span className="tag">RERANKER · 重排</span>
              <h4>重排模型</h4>
              <span className="hint">混合检索后精排 · 提升引用质量</span>
              <button className="btn" style={{marginLeft:'auto',padding:'5px 10px',fontSize:11.5}} onClick={()=>setOpenNewM({ kind:'rerank', target: null })}><Icon name="plus" size={11}/> 新增模型</button>
            </div>
            {appStore.MODELS.rerank.map(m=>{
              const state: string = testStates[m.id] || (m.tested?'ok':'idle');
              return (
                <div key={m.id} className={`mc-card ${m.default?'default':''}`}>
                  <span className="dot"/>
                  <div className="info">
                    <div className="nm">{m.name}{m.default && <span style={{marginLeft:8,fontSize:10.5,color:'var(--success)',fontWeight:500}}>· 默认</span>}</div>
                    <div className="meta"><span className="stamp">{m.provider}</span></div>
                  </div>
                  <button className={`test ${state==='testing'?'testing':''} ${state==='ok'?'ok':''}`} onClick={()=>test(m.id)}>
                    {state==='testing' ? <><span className="spinner"/> 测试中</> : state==='ok' ? <><Icon name="check" size={11}/> 连接正常</> : '测试连接'}
                  </button>
                  <button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setOpenNewM({ kind:'rerank', target:m })}>编辑</button><button className="btn" style={{padding:'5px 9px',fontSize:11.5,marginLeft:6}} onClick={()=>setConfirmDelM({...m,kind:'rerank'})}>删除</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sub==='providers' && (
        <>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            <button className="btn primary" onClick={()=>setOpenNewPv(true)}><Icon name="plus" size={12}/> 新增供应商</button>
          </div>
          <div className="admin-table">
            <div className="at-row head" style={{gridTemplateColumns:'1.4fr 2.4fr 1fr 1fr 130px'}}>
              <div>名称</div><div>Base URL</div><div>类型</div><div>API Key</div><div style={{textAlign:'right'}}>操作</div>
            </div>
            {appStore.PROVIDERS.map(p=>(
              <div key={p.id} className="at-row" style={{gridTemplateColumns:'1.4fr 2.4fr 1fr 1fr 130px'}}>
                <div>
                  <div className="nm-bold">{p.name}</div>
                  <div className="path" style={{marginTop:2}}>{p.note}</div>
                </div>
                <div className="path" style={{fontFamily:'SF Mono,Menlo,monospace'}}>{p.url}</div>
                <div>
                  <span className="badge" style={{background: p.kind==='gateway'?'#EDE7F8':p.kind==='selfhost'?'var(--kb-industry-soft)':'var(--surface-2)', color: p.kind==='gateway'?'#5D429A':p.kind==='selfhost'?'var(--kb-industry)':'var(--ink-3)'}}>
                    {p.kind==='ocr'?'PDF OCR':p.kind==='gateway'?'网关':p.kind==='selfhost'?'自托管':'外部API'}
                  </span>
                </div>
                <div style={{fontFamily:'SF Mono,Menlo,monospace',fontSize:11.5,color:'var(--ink-3)'}}>{p.keyMask}</div>
                <div className="actions">
                  <button onClick={()=>setEditProvider(p)}>编辑</button>
                  <button className="danger" onClick={()=>setConfirmDelPv(p)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {sub==='ocr' && <OcrConfigPanel/>}

      {(openNewPv || editProvider) && <NewProviderModal target={editProvider} onClose={()=>{setOpenNewPv(false);setEditProvider(null)}} onSaved={()=>{setOpenNewPv(false);setEditProvider(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {openNewM && <NewModelModal kind={openNewM.kind} target={openNewM.target} onClose={()=>setOpenNewM(null)} onSaved={()=>{setOpenNewM(null); window.dispatchEvent(new CustomEvent('app-data-refresh'));}}/>}
      {confirmDelPv && <ConfirmModal title="删除供应商" msg={<>确认删除供应商 <b style={{color:'var(--ink)'}}>{confirmDelPv.name}</b>？引用此供应商的所有模型将变为不可用状态，需先迁移。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers/${confirmDelPv.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelPv(null)}/>}
      {confirmDelM && <ConfirmModal title="删除模型" msg={<>确认删除模型 <b style={{color:'var(--ink)'}}>{confirmDelM.name}</b>？知识库中绑定此模型的将需要回退到默认。</>} onConfirm={async()=>{const response=await fetch(`${API_BASE_URL}/api/v1/admin/models/${confirmDelM.id}`,{method:'DELETE',headers:apiHeaders()}); if(!response.ok) throw new Error('删除失败'); window.dispatchEvent(new CustomEvent('app-data-refresh'));}} onClose={()=>setConfirmDelM(null)}/>}
    </>
  );
}

export function OcrConfigPanel(){
  const target = appStore.PROVIDERS.find(p=>p.kind==='ocr');
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const save = async () => {
    if (!target && (!apiKey.trim() || !secretKey.trim())) {
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'首次配置需要填写 API Key 和 Secret Key'}));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/providers${target ? `/${target.id}` : ''}`, {
        method: target ? 'PATCH' : 'POST',
        headers: {'Content-Type':'application/json',...apiHeaders()},
        body: JSON.stringify({
          name: '百度智能云 OCR', kind: 'ocr', baseUrl: 'https://aip.baidubce.com',
          defaultParams: {provider:'baidu', note:'扫描版/混合版 PDF 文档解析'},
          ...(apiKey.trim() ? {apiKey:apiKey.trim()} : {}),
          ...(secretKey.trim() ? {secretKey:secretKey.trim()} : {}),
        }),
      });
      const result = await response.json().catch(()=>({}));
      if (!response.ok) throw new Error(result.message || '保存失败');
      setApiKey(''); setSecretKey('');
      window.dispatchEvent(new CustomEvent('app-toast',{detail:'百度 OCR 配置已保存'}));
      window.dispatchEvent(new CustomEvent('app-data-refresh'));
    } catch(error) { window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error) || '保存失败'})); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/ocr/test`,{method:'POST',headers:apiHeaders()});
      const result = await response.json().catch(()=>({}));
      window.dispatchEvent(new CustomEvent('app-toast',{detail:result.status==='passed'?'百度 OCR 连接测试成功':(result.message||'百度 OCR 连接测试失败')}));
    } catch { window.dispatchEvent(new CustomEvent('app-toast',{detail:'百度 OCR 连接测试失败'})); }
    finally { setTesting(false); }
  };
  return <div className="mc">
    <div className="mc-cat embed">
      <div className="mc-cat-head"><span className="tag">PDF OCR · 扫描件</span><h4>百度智能云文档解析</h4><span className="hint">仅扫描版/混合版 PDF 调用；可读版不产生 OCR 费用</span></div>
      <div style={{padding:'18px 20px',maxWidth:680}}>
        <div className="field"><label>API Key {target?.hasApiKey && <span style={{color:'var(--success)',fontSize:11}}>（已配置：{target.keyMask}）</span>}</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={target?.hasApiKey?'留空表示保持不变':'百度智能云 API Key'}/></div>
        <div className="field"><label>Secret Key {target?.hasSecretKey && <span style={{color:'var(--success)',fontSize:11}}>（已配置：{target.secretKeyMask}）</span>}</label><input type="password" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder={target?.hasSecretKey?'留空表示保持不变':'百度智能云 Secret Key'}/></div>
        <div className="field"><label>接口地址</label><input value="https://aip.baidubce.com" readOnly/></div>
        <div style={{display:'flex',gap:8,marginTop:14}}><button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存配置'}</button><button className="btn" disabled={!target || testing} onClick={test}>{testing?'测试中…':'测试连接'}</button></div>
        <div style={{marginTop:14,color:'var(--ink-3)',fontSize:12,lineHeight:1.6}}>凭据只在服务端加密保存。保存后，API 在提交解析任务时通过内部链路传递，parser 任务状态和日志不会返回密钥。</div>
      </div>
    </div>
  </div>;
}

export function NewProviderModal({target, onClose, onSaved}: { target: ProviderRow | null; onClose: () => void; onSaved?: () => void }){
  const [kind, setKind] = useState(target?.kind || 'gateway');
  const [name, setName] = useState(target?.name || ''); const [baseUrl, setBaseUrl] = useState(target?.url || ''); const [apiKey, setApiKey] = useState(''); const [secretKey, setSecretKey] = useState(''); const [note, setNote] = useState(target?.defaultParams?.note || ''); const [gbrainRecipe, setGbrainRecipe] = useState(target?.defaultParams?.gbrainRecipe || 'openai'); const [saving, setSaving] = useState(false);
  const save = async () => { if (!name.trim() || !baseUrl.trim()) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/providers${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({name,kind,baseUrl,defaultParams:{note,gbrainRecipe},...(apiKey ? {apiKey} : {}),...(secretKey ? {secretKey} : {})})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'供应商已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error)||'保存失败'}));} finally{setSaving(false);} };
  return (
    <Modal title={target ? `编辑供应商 · ${target.name}` : '新增供应商'} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存'}</button>
      </>
    }>
      <div className="field"><label>名称<span className="req">*</span></label><input value={name} onChange={e=>setName(e.target.value)} placeholder="如：内部自建 vLLM"/></div>
      <div className="field"><label>类型<span className="req">*</span></label>
        <select value={kind} onChange={e=>setKind(e.target.value)}>
          <option value="gateway">网关（统一代理多个上游）</option>
          <option value="selfhost">自托管（TEI / vLLM / Ollama 等）</option>
          <option value="external">外部API（OpenAI / DeepSeek 等）</option>
          <option value="ocr">PDF OCR（百度智能云）</option>
        </select>
      </div>
      <div className="field"><label>Base URL<span className="req">*</span></label><input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://..."/></div>
      {kind!=='ocr' && <div className="field"><label>百纳 协议适配</label>
        <select value={gbrainRecipe} onChange={e=>setGbrainRecipe(e.target.value)}>
          <option value="openai">OpenAI 兼容</option><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="litellm">LiteLLM</option><option value="ollama">Ollama</option><option value="voyage">Voyage（向量）</option><option value="llama-server">llama.cpp（向量）</option><option value="llama-server-reranker">llama.cpp（重排）</option>
        </select>
        <div className="hint" style={{marginTop:6}}>模型类别会校验可用协议；不修改百纳引擎源码。</div>
      </div>}
      <div className="field"><label>API Key</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={kind==='selfhost'?'(自托管通常不需要)':'sk-...'}/></div>
      {kind==='ocr' && <div className="field"><label>Secret Key</label><input type="password" value={secretKey} onChange={e=>setSecretKey(e.target.value)} placeholder="百度智能云 Secret Key"/></div>}
      <div className="field"><label>备注</label><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="该供应商用途、限速、协议说明"/></div>
    </Modal>
  );
}

export function NewModelModal({kind, target, onClose, onSaved}: { kind: string; target: ModelRow | null; onClose: () => void; onSaved?: () => void }){
  const label = kind==='llm' ? '大语言模型' : kind==='fast_llm' ? '辅助小模型' : kind==='embedding' ? '嵌入模型' : '重排模型';
  const [modelName, setModelName] = useState(target?.modelName || target?.name || ''); const [providerId, setProviderId] = useState(target?.providerId || ''); const [contextLen, setContextLen] = useState(String(target?.contextLen || 8192)); const [dimensions, setDimensions] = useState(target?.dimensions ? String(target.dimensions) : ''); const [isDefault, setIsDefault] = useState(Boolean(target?.isDefault ?? target?.default)); const [saving, setSaving] = useState(false);
  const save = async () => { if (!modelName.trim() || !providerId) return; setSaving(true); try { const response=await fetch(`${API_BASE_URL}/api/v1/admin/models${target ? `/${target.id}` : ''}`,{method:target?'PATCH':'POST',headers:{'Content-Type':'application/json',...apiHeaders()},body:JSON.stringify({kind,modelName,providerId,contextLen,dimensions,isDefault})}); const result=await response.json().catch(()=>({})); if(!response.ok) throw new Error(result.message||'保存失败'); window.dispatchEvent(new CustomEvent('app-toast',{detail:'模型已保存'})); onSaved?.(); } catch(error){window.dispatchEvent(new CustomEvent('app-toast',{detail:errorMessage(error)||'保存失败'}));} finally{setSaving(false);} };
  return (
    <Modal title={`${target ? '编辑' : '新增'}${label}`} onClose={onClose} foot={
      <>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving?'保存中…':'保存'}</button>
      </>
    }>
      <div className="field"><label>模型名称<span className="req">*</span></label><input value={modelName} onChange={e=>setModelName(e.target.value)} placeholder={kind==='fast_llm' ? '如：qwen2.5-7b-instruct / gpt-4o-mini' : '如：qwen3-max / bge-m3 / bge-reranker-v2-m3'}/></div>
      <div className="field"><label>供应商<span className="req">*</span></label>
        <select value={providerId} onChange={e=>setProviderId(e.target.value)}><option value="">选择已注册的供应商…</option>{appStore.PROVIDERS.filter(p=>p.kind!=='ocr').map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {(kind==='llm' || kind==='fast_llm') && (
        <div className="field-row">
          <div className="field"><label>上下文长度</label><input value={contextLen} onChange={e=>setContextLen(e.target.value)} placeholder="如：8192"/></div>
          <div className="field"><label>最大输出</label><input placeholder="如：8K"/></div>
        </div>
      )}
      {kind==='embedding' && (
        <div className="field-row">
          <div className="field"><label>向量维度<span className="req">*</span></label><input value={dimensions} onChange={e=>setDimensions(e.target.value)} placeholder="如：1024"/></div>
          <div className="field"><label>批处理上限</label><input placeholder="如：64"/></div>
        </div>
      )}
      <div className="field">
        <label>默认参数（JSON）</label>
        <textarea placeholder='{"temperature": 0.7, "top_p": 0.9}' style={{fontFamily:'SF Mono,Menlo,monospace'}}/>
      </div>
      <div className="field">
        <label>设为默认</label>
        <select value={isDefault?'yes':'no'} onChange={e=>setIsDefault(e.target.value==='yes')}><option value="no">否</option><option value="yes">是（将替换现有默认）</option></select>
      </div>
    </Modal>
  );
}

