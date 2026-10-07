// Optional preload for leak diagnosis, never changes exit semantics.
const asyncHooks = require('node:async_hooks');
const fs = require('node:fs');
const live = new Map();
const relevant = new Set(['TCPWRAP', 'TCPCONNECTWRAP', 'Timeout', 'PROCESSWRAP', 'MESSAGEPORT', 'WORKER', 'TLSWRAP', 'HTTPCLIENTREQUEST']);
asyncHooks.createHook({
  init(id,type,trigger,resource) {
    if (!relevant.has(type)) return;
    live.set(id,{type,resource,stack:new Error().stack.split('\n').slice(2,15).join('\n')});
  },
  destroy(id) { live.delete(id); },
}).enable();
const dump = setTimeout(() => {
  const rows=[...live.values()].filter(row => row.resource !== dump && (typeof row.resource.hasRef !== 'function' || row.resource.hasRef())).map(row=>({type:row.type,delay:row.type==='Timeout'?row.resource._idleTimeout:undefined,stack:row.stack}));
  fs.writeSync(2, '\nJEST_LIVE_RESOURCE_DIAGNOSTICS '+JSON.stringify(rows,null,2)+'\n');
},Number(process.env.JEST_PROBE_AFTER_MS||50000));
dump.unref();
