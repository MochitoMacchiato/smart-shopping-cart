const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {decode}=require('./web/barcode-1d.js');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('tools/generate_samples.py','utf8');
const patterns=source.match(/PATTERNS = '''(.*?)'''/s)[1].trim().split(/\s+/);
function fixture(text,{badChecksum=false}={}){
 const values=Array.from(text,c=>c.charCodeAt(0)-32);
 const checksum=(104+values.reduce((sum,v,i)=>sum+v*(i+1),0))%103;
 const codes=[104,...values,badChecksum?(checksum+1)%103:checksum,106];
 const line=[...Array(20).fill(255)];
 for(const code of codes)Array.from(patterns[code],Number).forEach((n,i)=>line.push(...Array(n*3).fill(i%2?255:0)));
 line.push(...Array(20).fill(255));
 const width=line.length,height=120,gray=new Uint8Array(width*height);
 for(let y=0;y<height;y++)gray.set(y>10&&y<110?line:Array(width).fill(255),y*width);
 return {gray,width,height};
}
test('decodes distinct product strings and leading zero text without catalog guessing',()=>{
 for(const text of ['DEMO001','DEMO002','DEMO005','UNKNOWN999','001234']){
  const f=fixture(text);assert.equal(decode(f.gray,f.width,f.height,500)?.text,text);
 }
});
test('rejects invalid checksums and blank scenes',()=>{
 const f=fixture('DEMO001',{badChecksum:true});assert.equal(decode(f.gray,f.width,f.height,500),null);
 assert.equal(decode(new Uint8Array(640*480).fill(128),640,480,500),null);
});
test('actual user ESP32 frame decodes DEMO002 with checksum agreement',t=>{
 if(!fs.existsSync('esp32-live-frame.jpg')){t.skip('User diagnostic image is not present');return;}
 const result=spawnSync('python',['-c',"from PIL import Image; import json,base64; im=Image.open('esp32-live-frame.jpg').convert('L'); print(json.dumps({'width':im.width,'height':im.height,'gray':base64.b64encode(im.tobytes()).decode()}))"],{encoding:'utf8'});
 if(result.status!==0){t.skip('Pillow is required only for this JPEG regression test');return;}
 const f=JSON.parse(result.stdout),gray=new Uint8Array(Buffer.from(f.gray,'base64'));
 const hit=decode(gray,f.width,f.height,500);
 assert.equal(hit?.text,'DEMO002');assert.equal(hit?.format,'CODE_128');assert.ok(hit.lines>=2);
});
test('actual worker decodes Code 128 with CDN offline',async()=>{
 const fixtureImage=fixture('DEMO002'),messages=[];
 const context=vm.createContext({postMessage:message=>messages.push(message),setTimeout,clearTimeout,AbortController,fetch:async()=>{throw Error('offline');},console});
 context.importScripts=path=>{
  assert.ok(['/barcode-1d.js','/barcode-gray.js'].includes(path));vm.runInContext(fs.readFileSync('web'+path,'utf8'),context);
 };
 vm.runInContext(fs.readFileSync('web/camera-decoder.js','utf8'),context);
 const pixels=new Uint8ClampedArray(fixtureImage.width*fixtureImage.height*4);
 for(let i=0;i<fixtureImage.gray.length;i++){pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=fixtureImage.gray[i];pixels[i*4+3]=255;}
 await context.onmessage({data:{width:fixtureImage.width,height:fixtureImage.height,pixels:pixels.buffer,id:1}});
 assert.equal(messages[0].type,'ready');assert.equal(messages[1].result.text,'DEMO002');
});
