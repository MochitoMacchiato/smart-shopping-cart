const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const html=fs.readFileSync('web/index.html','utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(session=null){
 const nodes=new Map();
 function element(){return {value:'',children:[],append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},focus(){},scrollIntoView(){}};}
 for(const match of html.matchAll(/id="([^"]+)"/g))nodes.set(match[1],element());
 const get=id=>{assert.ok(nodes.has(id),'Unknown DOM ID '+id);return nodes.get(id)};
 let state={products:[],session,checkouts:[],storage:{backend:'firestore'}};
 let fail=false;const requests=[];
 const window={dispatchEvent(){}};
 const context={window,document:{getElementById:get,createElement:element,visibilityState:'visible'},Intl,Event,crypto:{randomUUID},setInterval(){},fetch:async(url,options)=>{
  if(!options)return {ok:true,json:async()=>state};
  requests.push({url,body:JSON.parse(options.body)});
  if(fail)return {ok:false,status:503,json:async()=>({error:'unavailable'})};
  const request=requests.at(-1);
  state={...state,session:{id:'session-1',status:'shopping',items:[],totalCentavos:0,ticket_no:'TKT-'+request.body.ticket_no}};
  return {ok:true,json:async()=>state};
 }};
 vm.runInNewContext(source,context);
 return {get,window,requests,fail:value=>fail=value};
}
test('ticket entry gates manual and camera cart changes',async()=>{
 const page=setup();await tick();
 assert.equal(page.get('scanButton').disabled,true);
 assert.equal(page.get('checkout').disabled,true);
 assert.equal(page.window.cartScanner.canEdit(),false);
 assert.equal(page.get('ticketForm').hidden,false);
 page.get('ticketDigits').value='13';
 await page.get('ticketForm').onsubmit({preventDefault(){}});
 assert.equal(page.requests.length,0);
 page.get('ticketDigits').value='0013';
 await page.get('ticketForm').onsubmit({preventDefault(){}});
 assert.equal(page.requests[0].url,'/api/new');
 assert.equal(page.requests[0].body.ticket_no,'0013');
 assert.equal(page.get('ticketDisplay').textContent,'TKT-0013');
 assert.equal(page.window.cartScanner.canEdit(),true);
 assert.equal(page.get('ticketForm').hidden,true);
 assert.equal(page.get('ticketDigits').value,'');
});
test('legacy active session assigns ticket without creating another session',async()=>{
 const page=setup({id:'old',status:'shopping',items:[],totalCentavos:0});await tick();
 assert.equal(page.window.cartScanner.canEdit(),false);
 page.get('ticketDigits').value='0007';
 await page.get('ticketForm').onsubmit({preventDefault(){}});
 assert.equal(page.requests[0].url,'/api/ticket');
 assert.equal(page.requests[0].body.sessionId,'old');
});
test('failed ticket submission retries original event and digits',async()=>{
 const page=setup();await tick();page.fail(true);
 page.get('ticketDigits').value='0013';
 await page.get('ticketForm').onsubmit({preventDefault(){}});
 const original=page.requests[0];
 assert.equal(page.window.cartScanner.canEdit(),false);
 assert.equal(page.get('retry').hidden,false);
 page.fail(false);
 await page.get('retry').onclick();
 assert.deepEqual(page.requests[1],original);
 assert.equal(page.window.cartScanner.canEdit(),true);
});
