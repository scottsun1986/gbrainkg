const fs = require('fs');
let code = fs.readFileSync('apps/web/src/app/ClientApp.tsx', 'utf-8');

// Ensure KNOWLEDGE_BASES is let (already done earlier)
code = code.replace(/function App\(\{ serverData \}: any\)\{/g, 'function App(){');
code = code.replace(/  if \(serverData\) \{[\s\S]*?    \}\n  \}\n/g, '');

const fetchHook = `
  const [dbData, setDbData] = useState(null);
  useEffect(() => {
    fetch('http://localhost:3000/api/v1/admin/data')
      .then(res => res.json())
      .then(d => {
        KNOWLEDGE_BASES = d.kbs.map((kb: any) => ({
          id: kb.id,
          type: kb.type,
          name: kb.name,
          desc: kb.description,
          docs: kb.docs?.length || 0,
          admins: kb.admins?.map((a: any) => ({ n: a.user?.displayName, i: a.user?.username })) || [],
          visibility: '通过接口加载',
          owner: 'System'
        }));
        USERS = d.users.map((u: any) => ({
          id: u.id,
          name: u.displayName,
          initial: u.username,
          role: '用户',
          org: '自动分配'
        }));
        setDbData(d);
      })
      .catch(err => {
        console.error(err);
        setDbData({ error: true }); // fallback
      });
  }, []);

  if (!dbData) return <div style={{padding:40,textAlign:'center',color:'#999'}}>系统正在加载企业数据底座，请稍候...</div>;
`;

// Insert after function App(){
code = code.replace('function App(){', 'function App(){\n' + fetchHook);

fs.writeFileSync('apps/web/src/app/ClientApp.tsx', code);
