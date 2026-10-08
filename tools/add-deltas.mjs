// Adds small delta packs to an unsigned Godot update payload, before it is signed (run by the publish workflow).
//   node add-deltas.mjs <staging folder> [previous godot-latest.json] [folder holding earlier full packs]
// The staging folder holds payload.json and the joined full pack(s). For every earlier build listed as a base (the
// previous manifest's own files plus its "bases"), the earlier full pack is read from the bases folder (named by its
// SHA-256, checked here), and a DNTDELT1 delta to the new DungeonAndTower.pck is written to the staging folder and
// listed in payload.deltas. payload.bases then names the full packs to keep for the next build (newest first).
// Players whose installed file matches a base download only the delta; anyone else gets the full pack as before.
import fs from 'node:fs';import path from 'node:path';import {encode,apply,sha256} from './delta.mjs';
const KEEP=4,FILE='DungeonAndTower.pck';
const [stageArg,prevArg,basesArg]=process.argv.slice(2);
if(!stageArg)throw new Error('usage: add-deltas.mjs <staging> [previous godot-latest.json] [bases folder]');
const stage=path.resolve(stageArg),hex=/^[0-9a-f]{64}$/;
const p=JSON.parse(fs.readFileSync(path.join(stage,'payload.json'),'utf8'));
const unpack=(packFile,want)=>{ // DNTPACK1 → the bytes of entry `want`
 const b=fs.readFileSync(packFile);if(b.subarray(0,8).toString()!=='DNTPACK1')throw new Error('not a pack: '+packFile);
 const n=b.readUInt32LE(8),entries=JSON.parse(b.subarray(12,12+n).toString());let o=12+n;
 for(const e of entries){if(e.path===want)return b.subarray(o,o+e.size);o+=e.size}
 return null;
};
const file=p.files.find(f=>f.path===FILE);if(!file)throw new Error('payload has no '+FILE);
const newPack=p.packs[file.pack],newB=unpack(path.join(stage,newPack.name),FILE);
if(!newB||sha256(newB)!==file.sha256)throw new Error('new pack does not hold the listed '+FILE);
// earlier builds: the previous manifest's file, then its bases
let bases=[];
if(prevArg&&fs.existsSync(prevArg)){
 try{
  const prev=JSON.parse(JSON.parse(fs.readFileSync(prevArg,'utf8')).payload);
  const pf=prev.files?.find(f=>f.path===FILE);
  if(pf)bases.push({version:prev.version,sha256:pf.sha256,size:pf.size,pack:prev.packs[pf.pack].name});
  for(const b of prev.bases??[])bases.push(b);
 }catch(e){console.log('::warning::previous manifest unreadable, no deltas: '+e.message)}
}
const seen=new Set([file.sha256]);
bases=bases.filter(b=>b&&hex.test(b.sha256)&&/^[0-9a-f]{64}\.pack$/.test(b.pack)&&!seen.has(b.sha256)&&seen.add(b.sha256)).slice(0,KEEP-1);
p.deltas=[];const kept=[];
for(const b of bases){
 const packFile=path.join(path.resolve(basesArg??stage),b.pack);
 if(!fs.existsSync(packFile)){console.log(`::warning::base ${b.version} (${b.pack}) is not available, skipped`);continue}
 const raw=fs.readFileSync(packFile);
 if(sha256(raw)+'.pack'!==b.pack){console.log(`::warning::base ${b.version} pack hash mismatch, skipped`);continue}
 const oldB=unpack(packFile,FILE);
 if(!oldB||sha256(oldB)!==b.sha256){console.log(`::warning::base ${b.version} does not hold the listed file, skipped`);continue}
 kept.push(b);
 const {pack,ops,literal}=encode(oldB,newB,FILE);
 if(!apply(oldB,pack).equals(newB))throw new Error('delta self-check failed for base '+b.version);
 if(pack.length>newPack.size/2){console.log(`base ${b.version}: delta ${pack.length} bytes is not worth it, skipped`);continue}
 const digest=sha256(pack);fs.writeFileSync(path.join(stage,digest+'.pack'),pack);
 p.packs.push({tag:newPack.tag,name:digest+'.pack',size:pack.length,sha256:digest});
 p.deltas.push({path:FILE,from:b.sha256,pack:p.packs.length-1});
 console.log(`delta ${b.version} → ${p.version}: ${(pack.length/1048576).toFixed(2)} MB (${ops} ops, ${literal} new bytes) vs full ${(newPack.size/1048576).toFixed(1)} MB`);
}
p.bases=[{version:p.version,sha256:file.sha256,size:file.size,pack:newPack.name},...kept].slice(0,KEEP);
fs.writeFileSync(path.join(stage,'payload.json'),JSON.stringify(p));
console.log(`payload: ${p.packs.length} packs, ${p.deltas.length} deltas, keeping ${p.bases.length} full packs as bases`);
