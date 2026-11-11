const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),vm=require('node:vm');
const {decode}=require('./web/barcode-gray.js');
const {patterns}=require('./web/barcode-1d.js');
function image(name,t){
 if(!fs.existsSync(name)){t.skip('User diagnostic image not present');return null;}
 const code="from PIL import Image; import json,base64,sys; im=Image.open(sys.argv[1]).convert('L'); print(json.dumps({'width':im.width,'height':im.height,'gray':base64.b64encode(im.tobytes()).decode()}))";
 const result=spawnSync('python',['-c',code,name],{encoding:'utf8'});
 if(result.status!==0){t.skip('Pillow is required for JPEG regression tests only');return null;}
 const value=JSON.parse(result.stdout);value.gray=new Uint8Array(Buffer.from(value.gray,'base64'));return value;
}
for(const name of ['esp32-live-frame (1).jpg','esp32-live-frame (2).jpg']){
 test('printed packaging regression: '+name,t=>{
  const f=image(name,t);if(!f)return;
  const result=decode(f.gray,f.width,f.height,1500);
  assert.equal(result?.text,'DEMO002');assert.equal(result?.format,'CODE_128');assert.ok(result.lines>=2);
 });
}
test('actual worker reads printed packaging with no internet',async t=>{
 const f=image('esp32-live-frame (2).jpg',t);if(!f)return;
 const messages=[],context=vm.createContext({postMessage:v=>messages.push(v),setTimeout,clearTimeout,AbortController,fetch:async()=>{throw Error('offline');},console});
 context.importScripts=path=>vm.runInContext(fs.readFileSync('web'+path,'utf8'),context);
 vm.runInContext(fs.readFileSync('web/camera-decoder.js','utf8'),context);
 const pixels=new Uint8ClampedArray(f.width*f.height*4);
 for(let i=0;i<f.gray.length;i++){pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=f.gray[i];pixels[i*4+3]=255;}
 await context.onmessage({data:{width:f.width,height:f.height,pixels:pixels.buffer,id:18}});
 const response=messages.find(v=>v.id===18);
 assert.equal(response.result?.text,'DEMO002');assert.match(response.result.strategy,/grayscale/);
});
function synthetic(text,invalid=false){
 const values=Array.from(text,c=>c.charCodeAt(0)-32),check=(104+values.reduce((sum,v,i)=>sum+v*(i+1),0))%103;
 const line=Array(30).fill(230);
 for(const symbol of [104,...values,invalid?(check+1)%103:check,106])patterns[symbol].forEach((n,i)=>line.push(...Array(n*4).fill(i%2?230:30)));
 line.push(...Array(30).fill(230));
 const blurred=line.map((_,x)=>{
  let sum=0,total=0;for(let k=-8;k<=8;k++){const weight=Math.exp(-k*k/8);sum+=(line[Math.max(0,Math.min(line.length-1,x+k))])*weight;total+=weight;}return sum/total;
 });
 const height=160,width=line.length,gray=new Uint8Array(width*height);
 for(let y=0;y<height;y++)gray.set(blurred,y*width);
 return {gray,width,height};
}
test('grayscale recovery is generic rather than restricted to DEMO002',()=>{
 for(const text of ['DEMO001','DEMO005','ABC123']){
  const f=synthetic(text),result=decode(f.gray,f.width,f.height,1500);
  assert.equal(result?.text,text);
 }
});
test('grayscale matcher rejects bad checksum and blank scene',()=>{
 const f=synthetic('DEMO002',true);
 assert.equal(decode(f.gray,f.width,f.height,1000),null);
 assert.equal(decode(new Uint8Array(640*480).fill(120),640,480,500),null);
});
