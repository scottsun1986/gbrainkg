import { createHash } from 'node:crypto';
import { readdirSync,readFileSync } from 'node:fs';
import { join,relative } from 'node:path';
/** Captured once at process boot, so rebuilding files cannot disguise an old running API. */
export function compiledApiIdentity(root: string): string {
 const files:string[]=[];
 const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})) {const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(entry.isFile() && entry.name.endsWith('.js'))files.push(path);}};
 walk(root);const hash=createHash('sha256');
 for(const path of files.sort())hash.update(relative(root,path).split('\\').join('/')).update(createHash('sha256').update(readFileSync(path)).digest());
 return hash.digest('hex');
}
