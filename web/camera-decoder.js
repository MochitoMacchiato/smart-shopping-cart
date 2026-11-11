/* Pixel-only worker: local Code 128 recovery, then native/ZXing fallback. */
importScripts('/barcode-1d.js');
importScripts('/barcode-gray.js');
const formats=['code_128','ean_13','ean_8','upc_a','upc_e','code_39','qr_code'];
let nativeFormats=null,zxingLoaded=false;
const initialize=(async()=>{
  if(typeof BarcodeDetector!=='undefined'){
    try{const supported=await BarcodeDetector.getSupportedFormats();nativeFormats=formats.filter(f=>supported.includes(f));}catch(_){}
  }
  if(!nativeFormats||!formats.every(f=>nativeFormats.includes(f))){
    // Download asynchronously: Code 128 scanning remains available offline and
    // a blocked CDN cannot freeze the worker's frame-processing queue.
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetch('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',{signal:controller.signal});
      if(!response.ok)throw Error('Decoder download failed');
      const source=await response.text();
      const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      try{importScripts(url);zxingLoaded=typeof ZXing!=='undefined';}finally{URL.revokeObjectURL(url);}
    }catch(_){}finally{clearTimeout(timer);}
  }
})();
postMessage({type:'ready',backend:'local multi-line Code 128 + optional native/ZXing'});
function zxingDecode(gray,width,height){
  const hints=new Map();
  // The recovery pass handles all rows; use TRY_HARDER for 1D-only fallback
  // without spending time searching every 2D symbology first.
  const types=[ZXing.BarcodeFormat.CODE_128,ZXing.BarcodeFormat.EAN_13,ZXing.BarcodeFormat.EAN_8,ZXing.BarcodeFormat.UPC_A,ZXing.BarcodeFormat.UPC_E,ZXing.BarcodeFormat.CODE_39];
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,types);
  hints.set(ZXing.DecodeHintType.TRY_HARDER,true);
  for(const inverse of [false,true]){
    const pixels=inverse?gray.map(v=>255-v):gray;
    const bitmap=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(pixels,width,height)));
    try{const hit=new ZXing.MultiFormatReader().decode(bitmap,hints);return {text:hit.getText(),format:ZXing.BarcodeFormat[hit.getBarcodeFormat()],strategy:'ZXing 1D recovery'};}
    catch(error){if(!(error instanceof ZXing.NotFoundException||error instanceof ZXing.ChecksumException||error instanceof ZXing.FormatException))throw error;}
  }
  return null;
}
onmessage=async({data})=>{
  try{
    const {width,height,pixels,id}=data;
    const rgba=new Uint8ClampedArray(pixels),gray=new Uint8ClampedArray(width*height);
    for(let i=0,j=0;i<gray.length;i++,j+=4)gray[i]=(rgba[j]+2*rgba[j+1]+rgba[j+2])/4;
    let result=Barcode1D.decode(gray,width,height,120);
    if(!result)result=BarcodeGray.decode(gray,width,height,900);
    if(!result&&nativeFormats?.length){
      const hits=await new BarcodeDetector({formats:nativeFormats}).detect(new ImageData(rgba,width,height));
      if(hits[0])result={text:hits[0].rawValue,format:hits[0].format,strategy:'native'};
    }
    if(!result&&zxingLoaded)result=zxingDecode(gray,width,height);
    postMessage({type:'result',id,result});
  }catch(error){postMessage({type:'error',id:data.id,error:error.message});}
};
