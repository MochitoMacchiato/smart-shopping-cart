/* Local Code 128 recovery: multiple scanlines and checksum agreement. */
(() => {
  const patterns='212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ').map(s=>Array.from(s,Number));
  function score(runs,at,pattern){
    if(at+pattern.length>runs.length)return Infinity;
    const sum=pattern.reduce((a,b)=>a+b,0),total=pattern.reduce((a,_,i)=>a+runs[at+i].n,0),unit=total/sum;
    if(unit<0.8)return Infinity;
    // Blur/thresholding widens dark bars while narrowing gaps, or vice versa.
    // Fit one bounded ink-spread offset per symbol before comparing widths.
    let bias=0;
    for(let i=0;i<pattern.length;i++)bias+=(runs[at+i].n/unit-pattern[i])*(i%2===0?1:-1);
    bias=Math.max(-0.8,Math.min(0.8,bias/pattern.length));
    let error=0;
    for(let i=0;i<pattern.length;i++){
      const diff=Math.abs(runs[at+i].n/unit-pattern[i]-bias*(i%2===0?1:-1));if(diff>1.15)return Infinity;
      error+=diff;
    }
    return error/sum;
  }
  function textOf(codes){
    let mode=codes[0]===103?'A':codes[0]===104?'B':'C',text='',shift=false;
    for(let i=1;i<codes.length-1;i++){
      const v=codes[i];
      if(v===102){if(i>1)text+='\x1d';continue;}
      if(mode==='C'){
        if(v<100){text+=String(v).padStart(2,'0');continue;}
        if(v===100){mode='B';continue;}if(v===101){mode='A';continue;}return null;
      }
      if(v===99){mode='C';continue;}
      if(v===100&&mode==='A'){mode='B';continue;}
      if(v===101&&mode==='B'){mode='A';continue;}
      if(v===98){if(shift)return null;shift=true;continue;}
      if(v>95)return null;
      const actual=shift?(mode==='A'?'B':'A'):mode;
      text+=String.fromCharCode(actual==='B'?v+32:v<64?v+32:v-64);shift=false;
    }
    return shift?null:text;
  }
  function decodeRuns(runs){
    for(let start=0;start+19<runs.length;start++){
      if(!runs[start].black)continue;
      let first=-1,best=0.23;
      for(let v=103;v<=105;v++){const fit=score(runs,start,patterns[v]);if(fit<best){best=fit;first=v;}}
      if(first<0)continue;
      const startUnit=runs.slice(start,start+6).reduce((sum,run)=>sum+run.n,0)/11;
      if(start===0||runs[start-1].black||runs[start-1].n<startUnit*5)continue;
      const codes=[first];let at=start+6;
      for(let count=0;count<90&&at+6<runs.length;count++,at+=6){
        let code=-1,fit=0.23;
        for(let v=0;v<=106;v++){const e=score(runs,at,patterns[v]);if(e<fit){fit=e;code=v;}}
        if(code<0)break;
        if(code===106){
          if(codes.length<3)break;
          const stopUnit=runs.slice(at,at+7).reduce((sum,run)=>sum+run.n,0)/13;
          if(!runs[at+7]||runs[at+7].black||runs[at+7].n<stopUnit*5)break;
          const checksum=(codes[0]+codes.slice(1,-1).reduce((sum,v,i)=>sum+v*(i+1),0))%103;
          if(checksum!==codes[codes.length-1])break;
          const text=textOf(codes);if(text)return text;break;
        }
        if(code>102)break;codes.push(code);
      }
    }
    return null;
  }
  function runsFor(line,threshold){
    const runs=[];let begin=0,black=line[0]<threshold[0];
    for(let x=1;x<line.length;x++){
      const next=line[x]<threshold[x];
      if(next!==black){
        const before=line[x-1]-threshold[x-1],after=line[x]-threshold[x];
        const crossing=x-1+Math.abs(before)/(Math.abs(before)+Math.abs(after)||1);
        runs.push({black,n:crossing-begin});begin=crossing;black=next;
      }
    }
    runs.push({black,n:line.length-begin});return runs;
  }
  function localThreshold(line,radius,fraction){
    const threshold=new Float32Array(line.length);
    for(let x=0;x<line.length;x++){
      let min=255,max=0;
      for(let j=Math.max(0,x-radius);j<=Math.min(line.length-1,x+radius);j++){min=Math.min(min,line[j]);max=Math.max(max,line[j]);}
      threshold[x]=min+(max-min)*fraction;
    }
    return threshold;
  }
  function decode(gray,width,height,budget=150){
    const started=Date.now(),votes=new Map();
    const rows=[.5,.4,.3,.6,.25,.35,.45,.55,.65,.2,.7,.15,.75,.8,.85];
    for(const slope of [0,-.06,.06,-.12,.12,-.2,.2])for(const fraction of rows){
      if(Date.now()-started>budget)return null;
      const y0=Math.round(height*fraction),line=new Float32Array(width);
      for(let x=0;x<width;x++){
        const y=Math.max(1,Math.min(height-2,Math.round(y0+slope*(x-width/2))));
        line[x]=(gray[(y-1)*width+x]+2*gray[y*width+x]+gray[(y+1)*width+x])/4;
      }
      let min=255,max=0;for(const v of line){min=Math.min(min,v);max=Math.max(max,v);}if(max-min<40)continue;
      const thresholds=[...([.5,.35,.65].map(f=>new Float32Array(width).fill(min+(max-min)*f))),...([.4,.5,.6].map(f=>localThreshold(line,32,f)))];
      for(const threshold of thresholds){
        const runs=runsFor(line,threshold);
        for(const candidate of [runs,[...runs].reverse()]){
          const text=decodeRuns(candidate);if(!text)continue;
          let lines=votes.get(text);if(!lines)votes.set(text,lines=new Set());lines.add(y0);
          if(lines.size>=2)return {text,format:'CODE_128',strategy:'multi-line checksum',lines:lines.size};
        }
      }
    }
    return null;
  }
  if(typeof module!=='undefined')module.exports={decode,patterns,textOf};else globalThis.Barcode1D={decode,patterns,textOf};
})();
