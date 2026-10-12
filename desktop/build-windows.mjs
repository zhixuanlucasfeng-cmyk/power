import {cpSync,mkdirSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
if(process.platform!=='win32')throw new Error('Build the Windows package on Windows (or use the Windows GitHub Actions workflow).');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'dist','Power-Windows-x64');
if(existsSync(out))throw new Error('Output already exists; move it aside before building again: '+out);
const electron=createRequire(import.meta.url)('electron');
mkdirSync(out,{recursive:true});
cpSync(dirname(electron),join(out,'runtime'),{recursive:true});
cpSync(process.execPath,join(out,'node.exe'));
const source=join(out,'resources','power');
mkdirSync(source,{recursive:true});
for(const name of readdirSync(root)){
 if(['.git','dist','node_modules','.DS_Store'].includes(name))continue;
 cpSync(join(root,name),join(source,name),{recursive:true});
}
cpSync(join(root,'node_modules'),join(source,'node_modules'),{recursive:true,filter:p=>basename(p)!=='electron'});
writeFileSync(join(out,'Power.cmd'),'@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset "POWER_ELECTRON=%~dp0runtime\\electron.exe"\r\n"%~dp0node.exe" "%~dp0resources\\power\\desktop\\launch.mjs"\r\nif errorlevel 1 pause\r\n');
console.log('Built '+out);
