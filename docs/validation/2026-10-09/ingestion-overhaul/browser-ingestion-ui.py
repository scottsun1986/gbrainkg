import json,sys
from playwright.sync_api import sync_playwright
calls=[]
qa_items=[{'id':'qa-old','title':'研发人工小时','status':'published','version':1,'displayVersion':2,'ingestVersion':2,'qaState':'needs_review','activeQa':{'id':'stable-1','question':'研发工时总计?','answer':'旧已发布答案','aliases':['研发时数'],'scope':'团队 A','language':'zh','reviewStatus':'approved'},'pendingQa':{'id':'stable-1','question':'研发工时总计?','answer':'候选新答案','aliases':['研发工作时长'],'scope':'团队 B','language':'zh','reviewStatus':'pending'}}]
batch={'id':'batch-1','archiveName':'fixture.zip','items':[{'path':'ok.md','status':'published','documentId':'doc-1'},{'path':'broken.csv','status':'failed','documentId':'doc-failed','reason':'fixture failure'}]}
def handler(route):
 req=route.request;url=req.url;path=url.split('/api/v1',1)[-1];calls.append((req.method,path))
 def reply(body,status=200): route.fulfill(status=status,content_type='application/json',body=json.dumps(body,ensure_ascii=False))
 if path=='/session/bootstrap':
  reply({'user':{'id':'u-test','username':'tester','displayName':'Browser Fixture','roles':[]},'capabilities':['chat.use','kb.read'],'kbs':[{'id':'kb-test','type':'personal','name':'浏览器验收库','canWrite':True,'canManage':True,'canDelete':False,'documentCount':1,'ownerUser':{'displayName':'Browser Fixture'}}]})
 elif path.startswith('/conversations'): reply({'items':[],'nextCursor':None,'hasMore':False})
 elif path=='/kbs/ingestion-capabilities': reply({'extensions':['pdf','docx','xlsx','md'],'qaExtensions':['csv','xlsx','jsonl'],'limits':{'uploadBytes':104857600,'archiveFiles':100,'archiveTotalBytes':524288000,'archiveFileBytes':104857600,'ocrBytes':20971520,'qaRows':10000,'qaBytes':10485760},'notes':[]})
 elif path.split('?',1)[0].endswith('/documents'):
  reply({'items':[{'id':'doc-1','title':'验收文档','mdPath':'fixtures/doc.md','sizeBytes':256,'status':'published','updatedAt':'2026-10-09T00:00:00Z','qualityStatus':'passed','qualityIssues':[],'parserMetadata':{'coverage':{'processed':8,'total':10,'failed':1,'skipped':1}}}],'total':1,'statusCounts':{'published':1}})
 elif path.endswith('/qa/preview'):
  reply({'fields':['Question','Answer','Aliases','Scope','Language'],'rows':[{'line':2,'question':'新标准问题?','answer':'新标准答案','aliases':['新别名'],'scope':'部门 C','language':'zh','errors':[]}],'errors':[],'warnings':[],'validCount':1})
 elif path.endswith('/qa') and req.method=='GET': reply({'items':qa_items})
 elif path.endswith('/qa/import'):
  body=json.loads(req.post_data or '{}');row=body['rows'][0];qa_items[:]=[{'id':'qa-new','title':row['question'],'status':'needs_review','version':0,'ingestVersion':1,'displayVersion':1,'qaState':'needs_review','activeQa':None,'pendingQa':{**row,'id':'qa-new','reviewStatus':'pending'}}];reply({'items':qa_items})
 elif path.endswith('/qa/qa-new/review'):
  item=qa_items[0];item.update(status='published',version=1,qaState='published',displayVersion=1,activeQa={**item['pendingQa'],'reviewStatus':'approved'},pendingQa=None);reply({'ok':True})
 elif path=='/kbs/imports/batch-1' and req.method=='GET': reply(batch)
 elif path=='/kbs/imports/batch-1/retry' and req.method=='POST': reply({'ok':True})
 else: reply({'items':[],'total':0,'statusCounts':{},'ok':True})
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page()
 page.add_init_script("window.localStorage.setItem('llmwiki_token','fixture-token')")
 page.route('**/api/v1/**',handler)
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:3212',wait_until='networkidle',timeout=90000)
 page.locator('aside .nav-item').filter(has_text='知识库').click();page.wait_for_timeout(700)
 if not page.locator('.kb-card').count(): raise AssertionError(f'no KB card; text={page.locator("body").inner_text()}; api_calls={calls}; page_errors={errors}')
 page.locator('.kb-card').filter(has_text='浏览器验收库').click();page.get_by_text('标准问答',exact=True).click();page.get_by_text('候选新答案',exact=True).wait_for()
 # Candidate and active versions are both shown with their independent scopes.
 assert page.get_by_text('团队 A',exact=False).count()>=1
 assert page.get_by_text('团队 B',exact=False).count()>=1
 # Upload fixture CSV, verify field mapping controls and mapped preview.
 page.get_by_label('选择问答文件').set_input_files({'name':'qa.csv','mimeType':'text/csv','buffer':b'Question,Answer,Aliases,Scope,Language\nQ,A,X,C,zh'})
 page.get_by_label('标准问题（必选）').select_option(label='Question')
 page.get_by_label('标准答案（必选）').select_option(label='Answer')
 page.get_by_role('button',name='按映射校验并预览').click()
 try: page.get_by_text('校验通过 1 条 / 总计 1 条',exact=False).wait_for(timeout=10000)
 except Exception as error: raise AssertionError(f'preview not rendered: {error}; body={page.locator("body").inner_text()}; api_calls={calls}')
 assert page.locator('table').get_by_text('新标准答案',exact=False).count()>=1
 page.get_by_role('button',name='保存 1 条候选').click();page.get_by_text('新标准答案',exact=True).wait_for()
 # Review the newly displayed candidate and ensure confirmation gate is active.
 page.get_by_role('button',name='审核候选内容').click();page.get_by_text('确认发布',exact=False).wait_for()
 confirm=page.get_by_role('button',name='确认审核并发布');assert confirm.is_disabled()
 page.get_by_label('我已核对标准答案、范围及有效期，确认发布').check();confirm.click();page.get_by_text('当前已发布 v1',exact=True).wait_for()
 # Import batch retry remains limited to failed entries.
 page.get_by_text('导入批次',exact=True).click();page.get_by_label('历史批次 ID').fill('batch-1');page.get_by_role('button',name='查看历史批次').click();page.get_by_text('broken.csv',exact=True).wait_for();page.get_by_label('选择重试 broken.csv').check();page.get_by_role('button',name='重试选中失败项（1）').click()
 # Coverage is visible in document list.
 page.get_by_text('文档（1）',exact=True).click();page.get_by_text('内容覆盖 8/10 · 失败 1 · 跳过 1',exact=True).wait_for()
 assert not errors,errors
 assert any(m=='POST' and path.endswith('/qa/preview') for m,path in calls)
 assert any(m=='POST' and path.endswith('/qa/import') for m,path in calls)
 assert any(m=='POST' and path.endswith('/qa/qa-new/review') for m,path in calls)
 assert any(m=='POST' and path.endswith('/kbs/imports/batch-1/retry') for m,path in calls)
 print(json.dumps({'result':'PASS','network_calls':calls,'page_errors':errors},ensure_ascii=False))
 browser.close()
