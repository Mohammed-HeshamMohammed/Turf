import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { observeRequest } from "./access-log.mjs";
test("request metadata is accurate and excludes queries, headers and bodies", async () => {
 const records=[];
 const server=createServer((req,res)=>{observeRequest(req,res,line=>records.push(JSON.parse(line)));res.statusCode=req.url==='/healthz'?200:403;res.end('same body');});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const response=await fetch(base+'/private?token=do-not-log',{method:'POST',headers:{authorization:'Bearer do-not-log'},body:'do-not-log'});
  assert.equal(response.status,403);assert.equal(await response.text(),'same body');
  await (await fetch(base+'/healthz')).text();assert.equal(records.length,1);
  assert.equal(records[0].method,'POST');assert.equal(records[0].path,'/private');assert.equal(records[0].status,403);
  assert.ok(records[0].duration_seconds>=0);assert.ok(!JSON.stringify(records).includes('do-not-log'));
 } finally {server.closeAllConnections();server.close();}
});
