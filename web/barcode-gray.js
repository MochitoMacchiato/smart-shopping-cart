/* Blur-aware Code 128 matcher. Fits image intensities rather than inventing edges. */
(() => {
  const base=typeof module!=='undefined'?require('./barcode-1d.js'):globalThis.Barcode1D;
  const positions=Array.from({length:40},(_,i)=>.7+9.6*i/39);
  const templates=new Map();
  function interpolate(row,x){let i=x|0;if(i<0)i=0;if(i>row.length-2)i=row.length-2;let f=x-i;if(f<0)f=0;if(f>1)f=1;return row[i]*(1-f)+row[i+1]*f;}
  function models(sigma){
    if(templates.has(sigma))return templates.get(sigma);
    const kernel=Array.from({length:49},(_,i)=>Math.exp(-((i-24)**2)/(2*(sigma*8)**2))),total=kernel.reduce((a,b)=>a+b,0);
    const result=base.patterns.map(pattern=>{
      const bits=Array(40).fill(0);
      pattern.forEach((n,i)=>bits.push(...Array(n*8).fill(i%2===0?1:0)));bits.push(...Array(40).fill(0));
      const blurred=bits.map((_,i)=>kernel.reduce((sum,k,j)=>sum+k*(bits[i+j-24]||0),0)/total);
      const sampled=positions.map(p=>interpolate(blurred,40+p*8)),mean=sampled.reduce((a,b)=>a+b,0)/sampled.length;
      const centered=sampled.map(v=>v-mean),norm=Math.hypot(...centered);
      return centered.map(v=>v/norm);
    });
    templates.set(sigma,result);return result;
  }
  function observe(row,x,unit){
    if(x<0||x+11*unit>=row.length)return null;
    const centered=new Float64Array(positions.length);let sum=0;
    for(let i=0;i<positions.length;i++){centered[i]=interpolate(row,x+positions[i]*unit);sum+=centered[i];}
    const mean=sum/positions.length;let squares=0;
    for(let i=0;i<centered.length;i++){centered[i]=mean-centered[i];squares+=centered[i]*centered[i];}
    const norm=Math.sqrt(squares);
    if(norm<35)return null;
    for(let i=0;i<centered.length;i++)centered[i]/=norm;
    return centered;
  }
  function correlation(model,observed){let sum=0;for(let i=0;i<model.length;i++)sum+=model[i]*observed[i];return sum;}
  function checksum(codes){return codes.length>=4&&(codes[0]+codes.slice(1,-2).reduce((sum,v,i)=>sum+v*(i+1),0))%103===codes[codes.length-2];}
  function lineDecode(row,deadline){
    let starts=[];
    for(const sigma of [.5,.7,.9]){
      const model=models(sigma);
      for(let unit=1.5;unit<=Math.min(8,row.length/40);unit+=.25)for(let x=4;x+45*unit<row.length;x+=2){
        const observed=observe(row,x,unit);if(!observed)continue;
        // Three legal start symbols; no catalog, product prefix, or expected length.
        for(const code of [103,104,105]){
          const fit=correlation(model[code],observed);
          if(fit>.94)starts.push({x,unit,sigma,codes:[code],cost:1-fit,minFit:fit});
        }
      }
      if(Date.now()>deadline)return null;
    }
    starts.sort((a,b)=>a.cost-b.cost);
    const selected=[];
    for(const s of starts){
      if(!selected.some(v=>Math.abs(v.x-s.x)<4&&Math.abs(v.unit-s.unit)<.4&&v.codes[0]===s.codes[0]))selected.push(s);
      if(selected.length>=5)break;
    }
    const valid=[];
    for(const start of selected){
      const model=models(start.sigma);let beams=[start];
      for(let index=1;index<40&&beams.length;index++){
        if(Date.now()>deadline)return null;
        const next=[];
        for(const b of beams)for(const delta of [-.1,0,.1])for(const shift of [-2,0,2]){
          const unit=b.unit+delta,x=b.x+11*b.unit+shift;
          if(unit<1||unit>9)continue;
          const observed=observe(row,x,unit);if(!observed)continue;
          let choices=[];
          for(let code=0;code<=106;code++){
            if(code>=103&&code!==106)continue;
            const fit=correlation(model[code],observed);
            if(fit>.9)choices.push({code,fit});
          }
          choices.sort((a,b)=>b.fit-a.fit);
          for(const choice of choices.slice(0,2)){
            const codes=[...b.codes,choice.code],cost=b.cost+1-choice.fit+.004*Math.abs(shift)+.03*Math.abs(delta);
            if(choice.code===106){
              // Confirm the final bar and right quiet margin, not merely the
              // first 11 modules of a stop-shaped partial symbol.
              const dark=interpolate(row,x+12*unit),quiet=interpolate(row,x+16*unit);
              if(checksum(codes)&&quiet-dark>20&&cost/codes.length<.065){
                const text=base.textOf(codes.slice(0,-1));if(text)valid.push({text,cost:cost/codes.length});
              }
            }else next.push({x,unit,sigma:b.sigma,codes,cost,minFit:Math.min(b.minFit,choice.fit)});
          }
        }
        next.sort((a,b)=>a.cost-b.cost);beams=next.slice(0,24);
      }
      if(valid.length)break;
    }
    valid.sort((a,b)=>a.cost-b.cost);
    const competing=valid.find(v=>v.text!==valid[0]?.text);
    if(competing&&competing.cost-valid[0].cost<.01)return null;
    return valid[0]||null;
  }
  function decode(gray,width,height,budget=700){
    const deadline=Date.now()+budget,votes=new Map();
    // Start centrally and sweep the full image; packaging labels can be anywhere.
    for(const fraction of [.4,.3,.5,.35,.45,.25,.55,.2,.6,.7,.15,.8]){
      if(Date.now()>deadline)return null;
      const y=Math.max(1,Math.min(height-2,Math.round(height*fraction))),row=new Float32Array(width);
      for(let x=0;x<width;x++)row[x]=(gray[(y-1)*width+x]+2*gray[y*width+x]+gray[(y+1)*width+x])/4;
      const candidate=lineDecode(row,deadline);if(!candidate)continue;
      let evidence=votes.get(candidate.text);if(!evidence)votes.set(candidate.text,evidence=[]);evidence.push(candidate);
      if(evidence.length>=2)return {text:candidate.text,format:'CODE_128',strategy:'grayscale blur fit + checksum',lines:evidence.length};
    }
    return null;
  }
  if(typeof module!=='undefined')module.exports={decode};else globalThis.BarcodeGray={decode};
})();
