const fs = require('fs');
let code = fs.readFileSync('apps/web/src/app/page.tsx', 'utf-8');

// The fetch block is already there, let's replace the `setDbData(d);` line with more assignments
code = code.replace(/setDbData\(d\);/g, `
        if (d.orgs) {
          ORG_TREE = d.orgs.reduce((acc: any, o: any) => { acc[o.id] = { name: o.name, count: 50 }; return acc; }, {});
        }
        setDbData(d);
`);

fs.writeFileSync('apps/web/src/app/page.tsx', code);
