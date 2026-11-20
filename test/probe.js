const fs=require('fs');const core=require('../src/dwf-core.js');
for(const f of process.argv.slice(2)){
  const t0=Date.now();
  try{
    const d=core.openDWF(new Uint8Array(fs.readFileSync(f)),f.split('/').pop());
    console.log('\n##',f.split('/').pop(),d.kind,'v'+d.version,'hojas:',d.sheets.length);
    d.sheets.forEach((s,i)=>{
      const sh=d.loadSheet(i);
      const kinds={};let n=0;
      sh.layers.forEach(l=>{if(l.data){n+=l.data.items.length;l.data.items.forEach(it=>kinds[it.k]=(kinds[it.k]||0)+1)}});
      console.log(' -',JSON.stringify(sh.title),sh.kind,'papel:',sh.paper?`${sh.paper.width.toFixed(1)}x${sh.paper.height.toFixed(1)}${sh.paper.units}`:'-','capas-res:',sh.layers.length,'items:',n,JSON.stringify(kinds),'ext:',sh.content&&sh.content.map(v=>+v.toFixed(2)).join(','),sh.warnings.length?'WARN '+sh.warnings.join('|'):'',JSON.stringify(sh.unsupported), 'capas:',sh.layers.map(l=>l.data?l.data.layers.length:0).join('+'));
    });
  }catch(e){console.log('\n##',f,'ERROR',e.message)}
  console.log('  ms',Date.now()-t0);
}
