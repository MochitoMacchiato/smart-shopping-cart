/* BarcodeDetector when available; pinned ZXing fallback for other browsers. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const formats = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code'];
  let decoder, loading, stream, opening=false, armed=false, decoding=false, generation=0, timer, deadline, last, attempt, action;
  let selectedPhoto, photoUrl;
  let activeSource='laptop', espLoadTimer, rejectEspLoad, espController, espFrameUrl;
  let espSequence=0, espLastFrameAt=0, espFrameTimes=[], espStatsTimer, decodedSequence=-1, freshAttempt=false;
  let heldPixels=null;
  let scanSessionId;
  function updateStreamStats(){
    const now=performance.now(),age=espSequence?(now-espLastFrameAt)/1000:0;
    espFrameTimes=espFrameTimes.filter(time=>now-time<10000);
    const fps=espFrameTimes.length>1?(espFrameTimes.length-1)/Math.max(0.001,(now-espFrameTimes[0])/1000):0;
    $('streamStats').textContent=espSequence?`${espSequence} complete frames received · ${fps.toFixed(1)} FPS · last frame ${age.toFixed(1)}s ago · ${$('espPreview').naturalWidth}×${$('espPreview').naturalHeight}${age>3?' · Stream is slow/stalled.':''}`:'Waiting for the first complete ESP32 frame…';
  }
  let cameraWorker, workerReady, pendingFrame, pendingInit, workerLoadTimer, frameId=0;
  function resetCameraDecoder(){
    cameraWorker?.terminate();cameraWorker=null;workerReady=null;
    clearTimeout(workerLoadTimer);
    if(pendingInit){pendingInit(Error('Camera scan cancelled.'));pendingInit=null;}
    if(pendingFrame){pendingFrame.reject(Error('Camera scan cancelled.'));pendingFrame=null;}
  }
  async function prepareCameraDecoder(){
    if(workerReady)return workerReady;
    workerReady=new Promise((resolve,reject)=>{
      const worker=cameraWorker=new Worker('/camera-decoder.js');
      pendingInit=reject;
      const timeout=workerLoadTimer=setTimeout(()=>{reject(Error('Camera decoder download timed out. Check internet access and try again.'));resetCameraDecoder();},20000);
      worker.onmessage=({data})=>{
        if(worker!==cameraWorker)return;
        if(data.type==='ready'){clearTimeout(timeout);pendingInit=null;resolve(data.backend);}
        else if(data.id&&pendingFrame?.id===data.id){
          const request=pendingFrame;pendingFrame=null;
          if(data.type==='error')request.reject(Error(data.error));else request.resolve(data.result);
        }else if(data.type==='error'){clearTimeout(timeout);reject(Error(data.error));resetCameraDecoder();}
      };
      worker.onerror=()=>{clearTimeout(timeout);reject(Error('Camera decoder failed. Stop and restart the camera.'));resetCameraDecoder();};
    });
    return workerReady;
  }
  function readCameraFrame(){
    freshAttempt=false;
    if(activeSource==='esp32'&&!heldPixels){
      if(!espSequence||decodedSequence===espSequence||performance.now()-espLastFrameAt>5000)return Promise.resolve(null);
      decodedSequence=espSequence;
    }
    if(activeSource==='esp32'&&heldPixels){
      freshAttempt=true;const pixels=heldPixels.pixels.slice();
      return new Promise((resolve,reject)=>{const id=++frameId;pendingFrame={id,resolve,reject};cameraWorker.postMessage({id,width:heldPixels.width,height:heldPixels.height,pixels:pixels.buffer},[pixels.buffer]);});
    }
    const video=activeSource==='esp32'?$('espPreview'):$('preview');
    const width=activeSource==='esp32'?video.naturalWidth:video.videoWidth;
    const height=activeSource==='esp32'?video.naturalHeight:video.videoHeight;
    if(!width||!height||(activeSource==='laptop'&&video.readyState<2))return Promise.resolve(null);
    if(activeSource==='laptop'&&video.paused){video.play().catch(()=>{});return Promise.resolve(null);}
    const scale=Math.min(1,960/width);
    const canvas=document.createElement('canvas');canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    freshAttempt=true;
    return new Promise((resolve,reject)=>{
      const id=++frameId;pendingFrame={id,resolve,reject};
      cameraWorker.postMessage({id,width:canvas.width,height:canvas.height,pixels:pixels.buffer},[pixels.buffer]);
    });
  }
  const log = [];
  const status = text => {$('scannerStatus').textContent = text;};
  function refresh() {
    const editable = window.cartScanner.canEdit();
    $('startCamera').disabled = !!stream || opening || decoding;
    $('stopCamera').disabled = !stream && !opening;
    $('scanOne').disabled = !stream || armed || decoding || !editable;
    $('cancelScan').disabled = !armed;
    $('photo').disabled = armed || decoding || opening;
    $('retryPhoto').disabled = !selectedPhoto || armed || decoding || opening;
    $('useDecoded').disabled = !last || armed || decoding || !editable;
    $('camera').disabled = !!stream || opening || $('cameraSource').value==='esp32';
    $('cameraSource').disabled = !!stream || opening;
    $('espHost').disabled = !!stream || opening;
    $('holdFrame').disabled = !stream || activeSource!=='esp32' || opening || armed;
    $('applyExposure').disabled = opening || armed;
    if (armed && (!editable||scanSessionId!==window.cartScanner.getState()?.session?.id)) cancel('Scan cancelled because the cart changed or is unavailable.');
  }
  function record(source, outcome, result) {
    log.push({time:new Date().toISOString(), source, outcome, barcode:result?.text||'', format:result?.format||'', milliseconds:Math.round(performance.now()-(attempt||performance.now()))});
    $('scanLog').textContent=log.map(r=>`${r.source}: ${r.outcome} ${r.barcode} ${r.format} (${r.milliseconds} ms)`).join('\n');
  }
  async function getDecoder() {
    if (decoder) return decoder;
    if (loading) return loading;
    loading = (async () => {
      if ('BarcodeDetector' in window) {
        try {
          const supported=await BarcodeDetector.getSupportedFormats();
          if (formats.every(f=>supported.includes(f))) {
            const native=new BarcodeDetector({formats});
            return decoder={read:async source=>{const hits=await native.detect(source);return hits[0]?{text:hits[0].rawValue,format:hits[0].format}:null;}};
          }
        } catch (_) { /* Try ZXing instead. */ }
      }
      status('Loading barcode decoder. Internet is needed for the ZXing fallback.');
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src='https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
        const timeout=setTimeout(()=>{script.remove();reject(Error('Decoder download timed out. Connect to the internet and try again.'));},20000);
        script.onload=()=>{clearTimeout(timeout);resolve();};
        script.onerror=()=>{clearTimeout(timeout);script.remove();reject(Error('Cannot load ZXing. Connect to the internet and retry. Typed entry still works.'));};
        document.head.append(script);
      });
      const hints=new Map();hints.set(ZXing.DecodeHintType.TRY_HARDER,true);
      return decoder={read:async source=>{
        // Keep decoder/canvas state local to this frame. Browser-reader reset is
        // also a camera lifecycle operation, so never use it to rearm a scan.
        const reader=new ZXing.BrowserMultiFormatReader(hints);
        try {const hit=reader.decode(source);return {text:hit.getText(),format:ZXing.BarcodeFormat[hit.getBarcodeFormat()]};}
        catch(e){if(e instanceof ZXing.NotFoundException||e instanceof ZXing.ChecksumException||e instanceof ZXing.FormatException)return null;throw e;}
      }};
    })();
    try{return await loading;}finally{loading=null;}
  }
  function showResult(result) {
    last=result;$('decodedValue').textContent=result.text;$('decodedFormat').textContent=result.format;
    const product=window.cartScanner.getState()?.products.find(p=>p.barcode===result.text&&p.active);
    $('decodedMatch').textContent=product?product.name:'Unknown product — cart will reject this code';
    refresh();
  }
  function cancel(message='Scan cancelled.') {
    if(armed) record('camera','cancelled');
    armed=false;generation++;clearTimeout(timer);clearTimeout(deadline);resetCameraDecoder();if(message)status(message);refresh();
  }
  function stop() {
    cancel('Camera stopped.');stream?.getTracks().forEach(track=>track.stop());stream=null;
    espController?.abort();espController=null;
    clearInterval(espStatsTimer);$('saveLiveFrame').hidden=true;$('saveLiveFrame').removeAttribute('href');
    heldPixels=null;$('holdFrame').textContent='Hold current frame for scanning';$('heldStatus').textContent='Scanning follows fresh live frames.';
    $('streamStats').textContent='ESP32 stream stopped.';
    if(espFrameUrl){URL.revokeObjectURL(espFrameUrl);espFrameUrl=null;}
    clearTimeout(espLoadTimer);
    if(rejectEspLoad){rejectEspLoad(Error('Camera connection cancelled.'));rejectEspLoad=null;}
    $('espPreview').onload=null;$('espPreview').onerror=null;$('espPreview').removeAttribute('src');$('espPreview').hidden=true;
    $('cameraConnection').textContent='Camera disconnected.';
    $('preview').srcObject=null;$('preview').hidden=true;refresh();
  }
  async function cameras() {
    const devices=await navigator.mediaDevices.enumerateDevices();const selected=$('camera').value;
    $('camera').replaceChildren(new Option('Default camera',''));
    devices.filter(d=>d.kind==='videoinput').forEach((d,i)=>$('camera').add(new Option(d.label||`Camera ${i+1}`,d.deviceId)));
    $('camera').value=selected;
  }
  $('startCamera').onclick=async()=>{
    activeSource=$('cameraSource').value==='esp32'?'esp32':'laptop';
    if(activeSource==='laptop'&&!navigator.mediaDevices?.getUserMedia){status('Camera access is unavailable. Open this dashboard on http://127.0.0.1:8000 and use a current browser.');return;}
    opening=true;const token=++generation;refresh();
    try {
      if(token!==generation)return;
      if(activeSource==='esp32'){
        espSequence=0;espLastFrameAt=0;espFrameTimes=[];decodedSequence=-1;
        updateStreamStats();
        const host=$('espHost').value.trim();
        if(!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(host)||!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)||host.split('.').some(p=>Number(p)>255))throw Error('Enter the camera private IP address only, for example 192.168.3.58.');
        const image=$('espPreview');image.hidden=false;
        $('cameraConnection').textContent='Connecting to ESP32-CAM '+host+'…';
        const controller=espController=new AbortController();
        await new Promise((resolve,reject)=>{
          rejectEspLoad=reject;
          espLoadTimer=setTimeout(()=>{controller.abort();reject(Error('No complete live frame within 12 seconds. Close other camera tabs and check the camera stream/power.'));},12000);
          (async()=>{
            const response=await fetch('/api/esp32/stream?host='+encodeURIComponent(host)+'&t='+Date.now(),{signal:controller.signal,cache:'no-store'});
            if(!response.ok){
              const body=await response.text();let message;
              try{message=JSON.parse(body).error;}catch(_){}
              throw Error(response.status===404?'Python server is outdated. Stop it with Ctrl+C, run python app.py again, then refresh.':message||`Camera proxy returned HTTP ${response.status}.`);
            }
            await window.MJPEG.consume(response,async pixels=>{
              if(controller.signal.aborted||token!==generation&&!stream)return;
              const url=URL.createObjectURL(new Blob([pixels],{type:'image/jpeg'}));
              image.src=url;
              try{await image.decode();}catch(error){URL.revokeObjectURL(url);throw Error('Browser could not display the camera JPEG.');}
              if(controller.signal.aborted){URL.revokeObjectURL(url);return;}
              if(espFrameUrl)URL.revokeObjectURL(espFrameUrl);espFrameUrl=url;
              espSequence++;espLastFrameAt=performance.now();espFrameTimes.push(espLastFrameAt);updateStreamStats();
              $('saveLiveFrame').href=url;$('saveLiveFrame').hidden=false;
              clearTimeout(espLoadTimer);rejectEspLoad=null;resolve();
            });
          })().catch(error=>{
            if(controller.signal.aborted)return;
            clearTimeout(espLoadTimer);
            if(rejectEspLoad){rejectEspLoad=null;reject(error);}
            else{stop();$('cameraConnection').textContent=error.message;status(error.message);}
          });
        });
        if(token!==generation)return;
        stream={getTracks:()=>[]};
        espStatsTimer=setInterval(updateStreamStats,500);
        $('cameraConnection').textContent='Live ESP32-CAM · '+host;
        status('ESP32-CAM is live. Select Add/Remove, then click Scan one item.');
        return;
      }
      const device=$('camera').value;
      const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{...(device?{deviceId:{exact:device}}:{}),width:{ideal:1280},height:{ideal:720}}});
      if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
      stream=acquired;$('preview').srcObject=stream;$('preview').hidden=false;await $('preview').play();
      await cameras();$('cameraConnection').textContent='Live laptop webcam';status('Camera ready. Select Add/Remove, then click Scan one item.');
    }catch(e){if(token!==generation)return;stream?.getTracks().forEach(t=>t.stop());stream=null;espController?.abort();espController=null;clearTimeout(espLoadTimer);rejectEspLoad=null;$('espPreview').onload=null;$('espPreview').onerror=null;$('espPreview').removeAttribute('src');$('espPreview').hidden=true;$('cameraConnection').textContent=e.message;$('preview').hidden=true;status(e.name==='NotAllowedError'?'Camera permission denied. Allow camera access in your browser; typed entry and photos still work.':`Camera could not start: ${e.message}`);}
    finally{opening=false;refresh();}
  };
  $('stopCamera').onclick=stop;
  $('cancelScan').onclick=()=>cancel();
  $('scanOne').onclick=async()=>{
    if(!stream||armed||!window.cartScanner.canEdit())return;
    scanSessionId=window.cartScanner.getState()?.session?.id;
    armed=true;last=null;action=window.cartScanner.mode();attempt=performance.now();const token=++generation;refresh();
    decodedSequence=-1;
    let frames=0;
    try{
      status('Preparing camera decoder…');
      await prepareCameraDecoder();
      if(!armed||token!==generation)return;
      if(activeSource==='laptop')await $('preview').play();
      if(!armed||token!==generation)return;
    }catch(error){if(token!==generation)return;armed=false;resetCameraDecoder();status(error.message);refresh();return;}
    attempt=performance.now();
    status(`Scanning one item (${action}). Hold the whole barcode steady in view. Timeout: 15 seconds.`);
    // This deadline also fires if a browser detector never resolves its promise.
    deadline=setTimeout(()=>{
      if(!armed||token!==generation)return;
      armed=false;generation++;clearTimeout(timer);resetCameraDecoder();record('camera','timeout');
      status('No barcode read in 15 seconds. Try more light, a larger code, or an uploaded photo.');refresh();
    },15000);
    async function frame(){
      if(!armed||token!==generation)return;
      try {
        const result=await readCameraFrame();
        if(!armed||token!==generation)return;
        if(result){armed=false;generation++;clearTimeout(deadline);resetCameraDecoder();record('camera','decoded',result);showResult(result);last=null;refresh();status('Decoded one barcode. Scan stopped; check the cart message for acceptance.');await window.cartScanner.apply(result.text,action);refresh();return;}
        if(freshAttempt)frames++;
        status(`Scanning one item (${action}) · ${frames} ${heldPixels?'held ':activeSource==='esp32'?'fresh ':''}frames checked · ${Math.max(0,15-Math.floor((performance.now()-attempt)/1000))} seconds left.${activeSource==='esp32'&&!freshAttempt?' Waiting for a new camera frame.':' Keep all bars and white margins visible and sharply focused.'}`);
        timer=setTimeout(frame,160);
      }catch(e){if(token!==generation)return;armed=false;generation++;clearTimeout(deadline);resetCameraDecoder();record('camera','error');status(`Scan failed: ${e.message}`);refresh();}
    }
    frame();
  };
  function photoStatus(message,error=false){
    $('photoStatus').textContent=message;
    $('photoStatus').style.background=error?'#ffebe4':'#edf3e9';
    status(message);
  }
  function localPhotoDecode(image){
    if(!window.Barcode1D)return null;
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,gray=new Uint8ClampedArray(canvas.width*canvas.height);
    for(let i=0,j=0;i<gray.length;i++,j+=4)gray[i]=(rgba[j]+2*rgba[j+1]+rgba[j+2])/4;
    return window.Barcode1D.decode(gray,canvas.width,canvas.height,150)||window.BarcodeGray?.decode(gray,canvas.width,canvas.height,900)||null;
  }
  async function decodePhoto(){
    const file=selectedPhoto;if(!file||decoding||armed||opening)return;
    last=null;
    $('decodedValue').textContent='—';$('decodedFormat').textContent='—';$('decodedMatch').textContent='—';
    if(file.size>15*1024*1024){photoStatus('Choose a photo smaller than 15 MB.',true);refresh();return;}
    decoding=true;attempt=performance.now();refresh();
    photoStatus(`Reading ${file.name||'selected photo'}… Please wait.`);
    let photoDeadline;
    try {
      const work=async()=>{
        const image=new Image();image.src=photoUrl;
        try{await image.decode();}catch(_){throw Error('The browser cannot open this image. Save it as PNG or JPEG and try again.');}
        if(image.naturalWidth*image.naturalHeight>25000000)throw Error('Photo is too large. Resize it to under 25 megapixels.');
        let result=localPhotoDecode(image);
        if(result)return result;
        const reader=await getDecoder();result=await reader.read(image);
        if(result)return result;
        // Photos of displays contain fine pixel patterns. Smaller, smoothed
        // versions can remove that noise while retaining the barcode bars.
        const longest=Math.max(image.naturalWidth,image.naturalHeight);
        for(const limit of [1280,960,640]){
          if(limit>=longest)continue;
          photoStatus(`Trying a smaller version of ${file.name||'selected photo'} (${limit}px)…`);
          const scale=limit/longest,canvas=document.createElement('canvas');
          canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);
          const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
          ctx.drawImage(image,0,0,canvas.width,canvas.height);
          const reduced=new Image();reduced.src=canvas.toDataURL('image/png');await reduced.decode();
          result=localPhotoDecode(reduced)||await reader.read(reduced);if(result)return result;
        }
        return null;
      };
      const result=await Promise.race([work(),new Promise((_,reject)=>{photoDeadline=setTimeout(()=>reject(Error('Decoding timed out. Try the original samples/DEMO004.png, then a smaller PNG or JPEG photo.')),25000);})]);
      if(result){record('photo','decoded',result);showResult(result);photoStatus(`Decoded ${result.text} (${result.format}). Select Add/Remove, then click Use decoded code in cart.`);}
      else{record('photo','not found');photoStatus('Photo opened, but no readable barcode was found. Try uploading the original samples/DEMO004.png. If that works, retake your photo with sharp bars and white margins.',true);}
    }catch(e){record('photo','error');photoStatus(`Photo could not be decoded: ${e.message}`,true);}
    finally{clearTimeout(photoDeadline);decoding=false;refresh();}
  }
  $('photo').onchange=()=>{
    const file=$('photo').files[0];if(!file)return;
    selectedPhoto=file;
    if(photoUrl)URL.revokeObjectURL(photoUrl);
    photoUrl=URL.createObjectURL(file);
    $('photoPreview').src=photoUrl;$('photoPreview').hidden=false;
    return decodePhoto();
  };
  $('retryPhoto').onclick=decodePhoto;
  $('cameraSource').onchange=()=>{
    $('espSettings').hidden=$('cameraSource').value!=='esp32';
    $('exposureSettings').hidden=$('cameraSource').value!=='esp32';
    refresh();
  };
  $('holdFrame').onclick=()=>{
    if(!stream||activeSource!=='esp32'||armed)return;
    if(heldPixels){heldPixels=null;$('holdFrame').textContent='Hold current frame for scanning';$('heldStatus').textContent='Scanning follows fresh live frames.';return;}
    const image=$('espPreview');if(!image.naturalWidth)return;
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    heldPixels={width:canvas.width,height:canvas.height,pixels:ctx.getImageData(0,0,canvas.width,canvas.height).data.slice()};
    $('holdFrame').textContent='Resume scanning live frames';$('heldStatus').textContent='Scan one item will use the held image. The live preview continues updating.';
  };
  $('applyExposure').onclick=async()=>{
    $('applyExposure').disabled=true;
    try{
      const response=await fetch('/api/esp32/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:$('espHost').value.trim(),profile:$('exposureProfile').value})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'Camera profile request failed.');
      heldPixels=null;$('holdFrame').textContent='Hold current frame for scanning';$('heldStatus').textContent='Scanning follows fresh live frames.';
      status(result.message);
    }catch(error){status('Exposure setting failed: '+error.message);}
    finally{refresh();}
  };
  $('useDecoded').onclick=async()=>{if(last&&window.cartScanner.canEdit()){const result=last;last=null;refresh();await window.cartScanner.apply(result.text,window.cartScanner.mode());}};
  $('downloadLog').onclick=()=>{
    const columns=['time','source','outcome','barcode','format','milliseconds'];
    const quote=v=>'"'+String(v).replaceAll('"','""')+'"';
    const csv=[columns.join(','),...log.map(row=>columns.map(c=>quote(row[c])).join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='scan-tests.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  window.addEventListener('cart-state',refresh);window.addEventListener('pagehide',stop);
  window.addEventListener('pagehide',()=>{if(photoUrl)URL.revokeObjectURL(photoUrl);});
  refresh();
})();
