const fs = require('fs');
let code = fs.readFileSync('apps/web/src/app/ClientApp.tsx', 'utf-8');

// Replace constant declarations with lets and assign them dynamically
code = code.replace(/const KNOWLEDGE_BASES = \[([\s\S]*?)\n\];/g, 'let KNOWLEDGE_BASES: any[] = [];');
code = code.replace(/const USERS = \[([\s\S]*?)\n\];/g, 'let USERS: any[] = [];');

code = code.replace('function App(){', 
`function App({ serverData }: any){
  if (serverData) {
    if (serverData.kbs) {
      KNOWLEDGE_BASES = serverData.kbs.map((kb: any) => ({
        id: kb.id,
        type: kb.type,
        name: kb.name,
        desc: kb.description,
        docs: kb.docs?.length || 0,
        admins: kb.kbAdmins?.map((a: any) => ({ n: a.user?.displayName, i: a.user?.username })) || [],
        visibility: '通过接口加载',
        owner: 'System'
      }));
    }
    if (serverData.users) {
      USERS = serverData.users.map((u: any) => ({
        id: u.id,
        name: u.displayName,
        initial: u.username,
        role: '用户',
        org: '加载中...'
      }));
    }
  }
`);

fs.writeFileSync('apps/web/src/app/ClientApp.tsx', code);
