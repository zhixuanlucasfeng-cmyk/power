import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';const require=createRequire(import.meta.url);
const {webURL,bounds}=require('./desktop/policy.cjs');
test('embedded browser restricts navigation and clamps native view to its window',()=>{
 assert.equal(webURL('https://example.com'),'https://example.com/');
 for(const u of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.com'])assert.throws(()=>webURL(u));
 assert.deepEqual(bounds({x:700,y:100,width:900,height:900},[1200,800]),{x:700,y:100,width:500,height:700});
 assert.throws(()=>bounds({x:NaN},[1200,800]));
});
