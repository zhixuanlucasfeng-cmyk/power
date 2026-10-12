import {cpSync,mkdirSync,writeFileSync,renameSync,existsSync,mkdtempSync} from 'node:fs';import {join,resolve,dirname} from 'node:path';import {homedir,tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=require('electron'),source=resolve(electron,'../../..'),stage=join(mkdtempSync(join(tmpdir(),'power-desktop-')),'Power.app');
cpSync(source,stage,{recursive:true,verbatimSymlinks:true});const resources=join(stage,'Contents/Resources'),bundle=join(resources,'app');mkdirSync(bundle,{recursive:true});
writeFileSync(join(bundle,'package.json'),JSON.stringify({name:'power',productName:'Power',version:'0.4.0',main:'bootstrap.cjs'}));
writeFileSync(join(bundle,'bootstrap.cjs'),`require(${JSON.stringify(join(root,'desktop/main.cjs'))});`);
const plist=join(stage,'Contents/Info.plist');for(const [key,value] of Object.entries({CFBundleName:'Power',CFBundleDisplayName:'Power',CFBundleIdentifier:'local.power.desktop'}))execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${value}`,plist]);
const applications=join(homedir(),'Applications'),out=join(applications,'Power.app');mkdirSync(applications,{recursive:true});
const icon=join(out,'Contents/Resources/Power.icns');if(existsSync(icon)){cpSync(icon,join(resources,'Power.icns'));execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIconFile Power.icns',plist]);}
execFileSync('codesign',['--force','--deep','--sign','-',stage],{stdio:'pipe'});
if(existsSync(out)){const backup=join(applications,`Power-backup-${Date.now()}.app`);renameSync(out,backup);console.log('Previous app preserved:',backup);}
renameSync(stage,out);console.log('Built',out);
