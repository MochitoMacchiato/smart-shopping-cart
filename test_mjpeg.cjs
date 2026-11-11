const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Parser,consume}=require('./web/mjpeg.js');
const jpeg=Buffer.from([255,216,1,2,3,255,217]);
const part=Buffer.concat([Buffer.from('\r\n--cartframe\r\nContent-Type: image/jpeg\r\nContent-Length: 7\r\n\r\n'),jpeg]);
test('multipart headers and JPEGs can be split at any network byte',()=>{
 const parser=new Parser(),frames=[];
 for(const byte of Buffer.concat([part,part,part]))frames.push(...parser.push(Uint8Array.of(byte)));
 assert.equal(frames.length,3);frames.forEach(frame=>assert.deepEqual(Buffer.from(frame),jpeg));
});
test('rejects invalid JPEG and oversized/missing length headers',()=>{
 assert.throws(()=>new Parser().push(Buffer.from('--x\r\nContent-Type: image/jpeg\r\n\r\n')),/missing/);
 assert.throws(()=>new Parser().push(Buffer.from('--x\r\nContent-Type: image/jpeg\r\nContent-Length: 9000000\r\n\r\n')),/length/);
 const invalid=Buffer.from(part);invalid[invalid.length-1]=0;
 assert.throws(()=>new Parser().push(invalid),/invalid JPEG/);
});
test('consumer emits newest frame per chunk and releases a closed stream',async()=>{
 let reads=0,cancelled=false,released=false;const frames=[];
 const response={body:{getReader:()=>({read:async()=>++reads===1?{done:false,value:Buffer.concat([part,part])}:{done:true},cancel:async()=>{cancelled=true;},releaseLock:()=>{released=true;}})}};
 await assert.rejects(()=>consume(response,async frame=>frames.push(frame)),/stream ended/);
 assert.equal(frames.length,1);assert.ok(cancelled&&released);
});
