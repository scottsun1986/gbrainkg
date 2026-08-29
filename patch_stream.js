const fs = require('fs');
const file = 'apps/web/src/app/page.tsx';
let code = fs.readFileSync(file, 'utf8');

const targetStr = `  // 流式输出状态机
  useEffect(()=>{
    if(!streaming) return;
    const full = CURRENT_ANSWER_PARTS.join('');
    let i = 0;
    const t = setInterval(()=>{
      i += 3;
      const done = i >= full.length;
      const slice = done ? full : full.slice(0, i);
      setMessages(ms=>{
        const cp = [...ms];
        cp[cp.length-1] = {...cp[cp.length-1], text: slice, done};
        return cp;
      });
      if(done){
        clearInterval(t);
        setStreaming(false);
        setTimeout(()=>{ if(taRef.current) taRef.current.focus(); }, 60);
      }
    }, 36);
    return ()=>clearInterval(t);
  },[streaming]);`;

const replacement = `  // 真实流式输出状态机对接
  useEffect(() => {
    if (!streaming) return;
    let active = true;
    (async () => {
      try {
        const userMsg = messages[messages.length - 2]?.text || "";
        const res = await fetch('http://localhost:3000/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userMsg, kb_scope: selected })
        });
        
        if (!res.ok) throw new Error("API Error");
        
        const reader = res.body?.getReader();
        const decoder = new TextDecoder('utf-8');
        let accumulatedText = "";
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value);
          const lines = chunkStr.split('\\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'delta') {
                  accumulatedText += data.content;
                  if (active) {
                    setMessages(ms => {
                      const cp = [...ms];
                      cp[cp.length - 1] = { ...cp[cp.length - 1], text: accumulatedText, done: false };
                      return cp;
                    });
                  }
                } else if (data.type === 'done') {
                  if (active) {
                    setMessages(ms => {
                      const cp = [...ms];
                      cp[cp.length - 1] = { ...cp[cp.length - 1], text: accumulatedText, done: true };
                      return cp;
                    });
                    setStreaming(false);
                  }
                }
              } catch (e) {}
            }
          }
        }
      } catch (err) {
         if (active) {
           setMessages(ms => {
             const cp = [...ms];
             cp[cp.length - 1] = { ...cp[cp.length - 1], text: "大模型请求失败: " + err.message, done: true };
             return cp;
           });
           setStreaming(false);
         }
      }
    })();
    return () => { active = false; };
  }, [streaming]);`;

code = code.replace(targetStr, replacement);
fs.writeFileSync(file, code);
console.log('Stream logic replaced!');
