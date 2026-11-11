// Scanner interaction tests with controlled camera/decoder results; no real hardware required.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup({fallback=false,manualTimers=false,photoSize=100}={}){
 const elements=new Map(),events={},applied=[];let stops=0,editable=true,httpError=null,liveFrame,detect=async()=>[{rawValue:'DEMO004',format:'code_128'}];
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',files:[],style:{},textContent:'',disabled:false,hidden:false,readyState:4,videoWidth:100,videoHeight:100,naturalWidth:100,naturalHeight:100,paused:false,play:async()=>{},decode:async()=>{},replaceChildren(){},add(){},removeAttribute(name){delete this[name];}});return elements.get(id);};
 const window={addEventListener:(name,fn)=>events[name]=fn,cartScanner:{canEdit:()=>editable,getState:()=>({products:[{barcode:'DEMO004',name:'Noodles',active:true}]}),mode:()=> 'add',apply:async(...args)=>applied.push(args)}};
 const context={window,document:{getElementById:el,createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(40000)})}),toDataURL:()=> 'data:image/png;base64,test'})},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]}),enumerateDevices:async()=>[]}},BarcodeDetector:class{static async getSupportedFormats(){return ['code_128','ean_13','ean_8','upc_a','upc_e','code_39','qr_code'];}async detect(){return detect();}},Option:class{},performance, setTimeout,clearTimeout,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},Image:class{naturalWidth=photoSize;naturalHeight=photoSize;async decode(){}},console};
 context.Worker=class{
  constructor(){queueMicrotask(()=>this.onmessage?.({data:{type:'ready',backend:'test'}}));}
  terminate(){this.stopped=true;}
  async postMessage(data){const hits=await detect();if(!this.stopped)this.onmessage({data:{type:'result',id:data.id,result:hits[0]?{text:hits[0].rawValue,format:hits[0].format}:null}});}
 };
 window.BarcodeDetector=context.BarcodeDetector;
 context.Blob=Blob;context.AbortController=AbortController;
 context.setInterval=()=>0;context.clearInterval=()=>{};
 context.fetch=async()=>({ok:!httpError,status:httpError?.status||200,text:async()=>JSON.stringify({error:httpError?.message})});
 window.MJPEG={consume:async(response,onFrame)=>{liveFrame=onFrame;await new Promise(()=>{});}};
 const timers=new Map();let timerId=0;
 if(manualTimers){
  context.setTimeout=(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;};
  context.clearTimeout=id=>timers.delete(id);
 }
 if(fallback){
  delete window.BarcodeDetector;
  // Stateful fallback: a consumed reader cannot decode another frame. A fresh
  // reader must be used without resetting/tearing down the live video source.
  class NotFound extends Error{}
  context.ZXing={DecodeHintType:{TRY_HARDER:1},BarcodeFormat:{1:'CODE_128'},NotFoundException:NotFound,ChecksumException:class extends Error{},FormatException:class extends Error{},BrowserMultiFormatReader:class{
   used=false;
   reset(){}
   decode(){if(this.used)throw new NotFound();this.used=true;return {getText:()=> 'DEMO004',getBarcodeFormat:()=>1};}
  }};
  context.document.createElement=()=>({remove(){}});
  context.document.head={append:script=>script.onload()};
 }
 vm.runInNewContext(fs.readFileSync('web/scanner.js','utf8'),context);
 return {el,events,applied,timers,pushLiveFrame:()=>liveFrame(new Uint8Array([255,216,255,217])),httpError:error=>httpError=error,stops:()=>stops,lock:()=>{editable=false;events['cart-state']();},result:fn=>detect=fn};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('one camera click submits once, then requires rearming; stop releases camera',async()=>{
 const s=setup();await s.el('startCamera').onclick();await s.el('scanOne').onclick();await tick();
 assert.deepEqual(s.applied,[['DEMO004','add']]);
 assert.equal(s.el('useDecoded').disabled,true);
 await tick();assert.equal(s.applied.length,1);
 await s.el('scanOne').onclick();await tick();assert.equal(s.applied.length,2);
 s.el('stopCamera').onclick();assert.equal(s.stops(),1);
});
test('cancellation ignores an in-flight decode',async()=>{
 const s=setup();let finish;s.result(()=>new Promise(r=>finish=r));
 await s.el('startCamera').onclick();await s.el('scanOne').onclick();s.el('cancelScan').onclick();
 finish([{rawValue:'DEMO004',format:'code_128'}]);await tick();assert.equal(s.applied.length,0);
 s.el('stopCamera').onclick();
});
test('checkout lock prevents scanning and accepting a decoded photo',async()=>{
 const s=setup();s.el('photo').files=[{size:100}];await s.el('photo').onchange();
 assert.equal(s.applied.length,0);assert.equal(s.el('decodedValue').textContent,'DEMO004');
 s.lock();await s.el('useDecoded').onclick();assert.equal(s.applied.length,0);
 assert.equal(s.el('useDecoded').disabled,true);
});
test('photo decode needs explicit confirmation and unknown result is visible',async()=>{
 const s=setup();s.el('photo').files=[{size:100}];await s.el('photo').onchange();
 assert.equal(s.applied.length,0);await s.el('useDecoded').onclick();assert.equal(s.applied.length,1);
 await s.el('useDecoded').onclick();assert.equal(s.applied.length,1);
 s.result(async()=>[{rawValue:'UNKNOWN999',format:'code_128'}]);await s.el('photo').onchange();
 assert.match(s.el('decodedMatch').textContent,/Unknown product/);
});
test('locking a cart cancels an in-flight camera read',async()=>{
 const s=setup();let finish;s.result(()=>new Promise(r=>finish=r));
 await s.el('startCamera').onclick();await s.el('scanOne').onclick();s.lock();
 finish([{rawValue:'DEMO004',format:'code_128'}]);await tick();
 assert.equal(s.applied.length,0);assert.equal(s.el('scanOne').disabled,true);
 s.el('stopCamera').onclick();
});
test('isolated live decoder can scan repeatedly without restarting the camera',async()=>{
 const s=setup();await s.el('startCamera').onclick();
 try{
  for(let i=1;i<=3;i++){
   await s.el('scanOne').onclick();await tick();
   assert.equal(s.applied.length,i);
  }
  assert.equal(s.stops(),0);
 }finally{s.el('stopCamera').onclick();}
});
test('deadline ends a stalled decode and ignores its late result after rearming',async()=>{
 const s=setup({manualTimers:true});let finish;
 s.result(()=>new Promise(r=>finish=r));await s.el('startCamera').onclick();await s.el('scanOne').onclick();
 const deadline=[...s.timers.values()].find(t=>t.delay===15000);
 assert.ok(deadline);deadline.fn();assert.match(s.el('scannerStatus').textContent,/No barcode read in 15 seconds/);
 assert.equal(s.el('scanOne').disabled,false);
 s.result(async()=>[{rawValue:'DEMO004',format:'code_128'}]);
 await s.el('scanOne').onclick();await tick();assert.equal(s.applied.length,1);
 finish([{rawValue:'DEMO004',format:'code_128'}]);await tick();assert.equal(s.applied.length,1);
 s.el('stopCamera').onclick();
});
test('unreadable photo keeps the selection and preview, clears old result, and can retry',async()=>{
 const s=setup();s.el('photo').files=[{name:'barcode.jpg',size:100}];s.el('photo').value='barcode.jpg';
 await s.el('photo').onchange();assert.equal(s.el('decodedValue').textContent,'DEMO004');
 s.result(async()=>[]);await s.el('retryPhoto').onclick();
 assert.equal(s.el('photo').value,'barcode.jpg');assert.equal(s.el('photoPreview').hidden,false);
 assert.match(s.el('photoStatus').textContent,/no readable barcode/);
 assert.equal(s.el('decodedValue').textContent,'—');assert.equal(s.el('useDecoded').disabled,true);
 assert.equal(s.applied.length,0);
 s.result(async()=>[{rawValue:'DEMO004',format:'code_128'}]);await s.el('retryPhoto').onclick();
 assert.match(s.el('photoStatus').textContent,/Decoded DEMO004/);
});
test('photo timeout is visible and re-enables photo retry',async()=>{
 const s=setup({manualTimers:true});s.result(()=>new Promise(()=>{}));
 s.el('photo').files=[{name:'barcode.jpg',size:100}];const work=s.el('photo').onchange();
 await tick();const deadline=[...s.timers.values()].find(t=>t.delay===25000);assert.ok(deadline);
 deadline.fn();await work;
 assert.match(s.el('photoStatus').textContent,/timed out/);assert.equal(s.el('retryPhoto').disabled,false);
 assert.equal(s.applied.length,0);
});
test('photo retries a reduced image after original fails, without changing cart',async()=>{
 const s=setup({photoSize:2048});let reads=0;
 s.result(async()=>++reads===1?[]:[{rawValue:'DEMO001',format:'code_128'}]);
 s.el('photo').files=[{name:'Try-DEMO001.jpg',size:100}];await s.el('photo').onchange();
 assert.equal(reads,2);assert.equal(s.el('decodedValue').textContent,'DEMO001');assert.equal(s.applied.length,0);
 assert.match(s.el('photoStatus').textContent,/Decoded DEMO001/);
});
test('ESP32 live image feeds repeat scans and disconnects without webcam access',async()=>{
 const s=setup();s.el('cameraSource').value='esp32';s.el('espHost').value='192.168.3.58';
 s.el('cameraSource').onchange();assert.equal(s.el('espSettings').hidden,false);
 const start=s.el('startCamera').onclick();
 await tick();await s.pushLiveFrame();await start;
 assert.match(s.el('cameraConnection').textContent,/Live ESP32/);
 assert.match(s.el('streamStats').textContent,/1 complete frames received/);
 assert.equal(s.el('saveLiveFrame').hidden,false);
 for(let i=1;i<=3;i++){
  await s.el('scanOne').onclick();await tick();assert.equal(s.applied.length,i);
 }
 assert.equal(s.el('espPreview').hidden,false);
 s.el('stopCamera').onclick();assert.equal(s.el('espPreview').hidden,true);
 assert.equal(s.el('saveLiveFrame').hidden,true);
 assert.equal(s.el('espPreview').src,undefined);assert.equal(s.stops(),0);
});
test('ESP32 stream error leaves controls available to reconnect',async()=>{
 const s=setup();s.el('cameraSource').value='esp32';s.el('espHost').value='192.168.3.58';
 s.httpError({status:502,message:'Camera stream unavailable: connection refused on port 81.'});
 await s.el('startCamera').onclick();
 assert.equal(s.el('startCamera').disabled,false);assert.equal(s.el('scanOne').disabled,true);
 assert.match(s.el('scannerStatus').textContent,/connection refused on port 81/);
 assert.match(s.el('cameraConnection').textContent,/connection refused on port 81/);
});
test('missing proxy endpoint identifies an old Python server',async()=>{
 const s=setup();s.el('cameraSource').value='esp32';s.el('espHost').value='192.168.3.58';
 s.httpError({status:404,message:'Not found'});await s.el('startCamera').onclick();
 assert.match(s.el('cameraConnection').textContent,/Python server is outdated/);
});
test('ESP32 scan does not repeatedly decode an unchanged received frame',async()=>{
 const s=setup({manualTimers:true});let reads=0;s.result(async()=>{reads++;return [];});
 s.el('cameraSource').value='esp32';s.el('espHost').value='192.168.3.58';
 const start=s.el('startCamera').onclick();await tick();await s.pushLiveFrame();await start;
 await s.el('scanOne').onclick();await tick();assert.equal(reads,1);
 const retry=[...s.timers.values()].find(timer=>timer.delay===160);await retry.fn();await tick();
 assert.equal(reads,1);assert.match(s.el('scannerStatus').textContent,/Waiting for a new camera frame/);
 await s.pushLiveFrame();await retry.fn();await tick();assert.equal(reads,2);
 s.el('stopCamera').onclick();
});
test('held ESP32 frame can be scanned while live frames continue arriving',async()=>{
 const s=setup();s.el('cameraSource').value='esp32';s.el('espHost').value='192.168.3.58';
 const start=s.el('startCamera').onclick();await tick();await s.pushLiveFrame();await start;
 s.el('holdFrame').onclick();assert.match(s.el('heldStatus').textContent,/held image/);
 await s.pushLiveFrame();await s.el('scanOne').onclick();await tick();assert.equal(s.applied.length,1);
 assert.equal(s.el('espPreview').hidden,false);
 s.el('holdFrame').onclick();assert.match(s.el('heldStatus').textContent,/fresh live/);
 s.el('stopCamera').onclick();
});
