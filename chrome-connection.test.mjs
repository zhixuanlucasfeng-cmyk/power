import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowser } from './browser.mjs';
test('browser connection choice persists and rejects unknown modes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'power-chrome-'));const b=createBrowser({home});
 try {
  assert.equal(b.status().mode,'managed');
  await b.panel('configure',{mode:'extension'});
  assert.equal(b.status().mode,'extension');
  assert.equal(createBrowser({home}).status().mode,'extension');
  await assert.rejects(b.panel('configure',{mode:'anything'}),/模式/);
  await b.panel('configure',{mode:'managed'});
  assert.equal(b.status().mode,'managed');
 } finally {await b.close();rmSync(home,{recursive:true,force:true});}
});
