"""Apply the reviewed release policy without exposing or changing credentials."""
import argparse,os,tempfile
from pathlib import Path

def apply(env_file:Path, policy_file:Path):
 values={line.split('=',1)[0]:line.split('=',1)[1] for line in policy_file.read_text().splitlines() if line and not line.startswith('#')}
 old=env_file.read_text();result=[];seen=set()
 for line in old.splitlines():
  key=line.split('=',1)[0].strip()
  if key in values:
   if key not in seen:result.append(key+'='+values[key]);seen.add(key)
  else:result.append(line)
 missing=[key+'='+value for key,value in values.items() if key not in seen]
 if missing:result+=['']+missing
 content='\n'.join(result)+'\n'
 if content==old:return False
 # Backup the exact previous environment once per content, privately.
 import hashlib
 backup=env_file.with_name(env_file.name+'.before-quality-'+hashlib.sha256(old.encode()).hexdigest()[:12])
 if not backup.exists():
  with open(backup,'x') as file:file.write(old)
  backup.chmod(0o600)
 resolved=env_file.resolve()
 fd,tmp=tempfile.mkstemp(prefix='.knowledge-profile-',dir=resolved.parent)
 try:
  with os.fdopen(fd,'w') as file:file.write(content)
  os.chmod(tmp,resolved.stat().st_mode & 0o777);os.replace(tmp,resolved)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
 return True

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('env_file',type=Path);parser.add_argument('--policy',type=Path,default=Path(__file__).resolve().parent/'config/knowledge-quality-first.env');args=parser.parse_args()
 print('knowledge quality-first policy:', 'applied' if apply(args.env_file,args.policy) else 'already current')
