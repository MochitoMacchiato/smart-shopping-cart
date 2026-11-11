/* Incremental multipart JPEG reader for the ESP32 firmware's Content-Length frames. */
(() => {
  class Parser {
    constructor(){this.buffer=new Uint8Array();this.length=null;}
    push(chunk){
      if(this.buffer.length+chunk.length>4*1024*1024)throw Error('Camera frame exceeds the 4 MB limit.');
      const joined=new Uint8Array(this.buffer.length+chunk.length);joined.set(this.buffer);joined.set(chunk,this.buffer.length);this.buffer=joined;
      const frames=[];
      while(true){
        if(this.length===null){
          let end=-1;
          for(let i=0;i+3<this.buffer.length;i++)if(this.buffer[i]===13&&this.buffer[i+1]===10&&this.buffer[i+2]===13&&this.buffer[i+3]===10){end=i;break;}
          if(end<0){if(this.buffer.length>8192)throw Error('Invalid camera stream headers.');break;}
          const header=new TextDecoder().decode(this.buffer.subarray(0,end));
          const match=header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
          if(!match||!/(?:^|\r\n)Content-Type:\s*image\/jpeg/i.test(header))throw Error('Camera stream is missing JPEG frame headers. Re-upload the live firmware.');
          this.length=Number(match[1]);
          if(this.length<4||this.length>4*1024*1024)throw Error('Invalid camera JPEG length.');
          this.buffer=this.buffer.slice(end+4);
        }
        if(this.buffer.length<this.length)break;
        const frame=this.buffer.slice(0,this.length);
        if(frame[0]!==255||frame[1]!==216||frame[frame.length-2]!==255||frame[frame.length-1]!==217)throw Error('Camera returned an incomplete or invalid JPEG.');
        frames.push(frame);this.buffer=this.buffer.slice(this.length);this.length=null;
      }
      return frames;
    }
  }
  async function consume(response,onFrame){
    if(!response.body?.getReader)throw Error('This browser cannot read live camera streams. Use a current Chrome or Edge.');
    const reader=response.body.getReader(),parser=new Parser();
    try{
      while(true){
        const {done,value}=await reader.read();
        if(done)throw Error('Camera stream ended. Check camera power/Wi-Fi, then reconnect.');
        const frames=parser.push(value);
        if(frames.length)await onFrame(frames[frames.length-1]); // Drop older queued frames to keep preview current.
      }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  if(typeof module!=='undefined')module.exports={Parser,consume};
  else window.MJPEG={Parser,consume};
})();
