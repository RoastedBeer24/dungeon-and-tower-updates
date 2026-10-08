// Binary delta between two builds of a file (DungeonAndTower.pck), for small in-game updates.
//   node delta.mjs make  <old file> <new file> <out dir>   → <out dir>/<sha256>.pack, prints {name,size,sha256,from,from_size,to,to_size}
//   node delta.mjs apply <old file> <delta pack> <out file> (check: rebuilds the new file the way the game does)
//
// Format (read by godot/app/updater.gd _apply_delta):
//   "DNTDELT1" | uint32 LE header length | JSON {path, from, from_size, to, to_size}
//   then ops until the end: 0x01 u64 offset u64 length  = copy that range of the old file
//                           0x02 u64 length <bytes>      = these bytes
// The game only trusts the result after its SHA-256 matches the signed manifest (to), and falls back to the full pack.
//
// Matching: content-defined chunks (gear rolling hash) of the old file are indexed; chunks of the new file found
// there become copies, which are then extended byte by byte into the neighbouring literal data. Moved files (Godot
// reorders some pck entries between exports) cost nothing; a changed file costs about its own size.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const MIN=2048,MAX=65536,MASK=(1<<13)-1;
const GEAR=(()=>{const g=new Uint32Array(256);let x=0x9e3779b9;for(let i=0;i<256;i++){x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;g[i]=x}return g})();
function* chunks(buf){
 let start=0;const n=buf.length;
 while(start<n){
  let end=Math.min(n,start+MAX),i=Math.min(n,start+MIN),h=0;
  for(;i<end;i++){h=((h<<1)+GEAR[buf[i]])>>>0;if((h&MASK)===0){end=i+1;break}}
  yield [start,end];start=end;
 }
}
const key=(buf,a,b)=>createHash('sha1').update(buf.subarray(a,b)).digest('base64');
export const sha256=b=>createHash('sha256').update(b).digest('hex');

/** ops: [{copy:[offset,len]} | {data:[start,end]}] over the new buffer */
export function diff(oldB,newB){
 const index=new Map();
 for(const [a,b] of chunks(oldB)){const k=key(oldB,a,b);if(!index.has(k))index.set(k,a)}
 const ops=[];
 const pushData=(a,b)=>{if(b<=a)return;const l=ops.at(-1);if(l?.data&&l.data[1]===a)l.data[1]=b;else ops.push({data:[a,b]})};
 for(const [a,b] of chunks(newB)){
  const o=index.get(key(newB,a,b));
  if(o!==undefined&&oldB.compare(newB,a,b,o,o+(b-a))===0)ops.push({copy:[o,b-a],at:a});else pushData(a,b);
 }
 // extend copies into neighbouring data (forward, then backward)
 for(let i=0;i<ops.length;i++){
  const c=ops[i];if(!c.copy)continue;
  const nx=ops[i+1];
  if(nx?.data){let [s,e]=nx.data,o=c.copy[0]+c.copy[1];while(s<e&&o<oldB.length&&oldB[o]===newB[s]){s++;o++;c.copy[1]++}nx.data[0]=s}
  const pv=ops[i-1];
  if(pv?.data){let [s,e]=pv.data;while(e>s&&c.copy[0]>0&&oldB[c.copy[0]-1]===newB[e-1]){e--;c.copy[0]--;c.copy[1]++;c.at--}pv.data[1]=e}
 }
 // drop empty data, merge copies that continue each other
 const out=[];
 for(const op of ops){
  if(op.data&&op.data[1]<=op.data[0])continue;
  const l=out.at(-1);
  if(op.copy&&l?.copy&&l.copy[0]+l.copy[1]===op.copy[0]){l.copy[1]+=op.copy[1];continue}
  if(op.data&&l?.data&&l.data[1]===op.data[0]){l.data[1]=op.data[1];continue}
  out.push(op.copy?{copy:[...op.copy]}:{data:[...op.data]});
 }
 return out;
}

export function encode(oldB,newB,filePath){
 const ops=diff(oldB,newB);
 const header=Buffer.from(JSON.stringify({path:filePath,from:sha256(oldB),from_size:oldB.length,to:sha256(newB),to_size:newB.length}));
 const parts=[Buffer.from('DNTDELT1'),Buffer.alloc(4),header];parts[1].writeUInt32LE(header.length);
 let literal=0;
 for(const op of ops){
  if(op.copy){const b=Buffer.alloc(17);b[0]=1;b.writeBigUInt64LE(BigInt(op.copy[0]),1);b.writeBigUInt64LE(BigInt(op.copy[1]),9);parts.push(b)}
  else{const b=Buffer.alloc(9);b[0]=2;b.writeBigUInt64LE(BigInt(op.data[1]-op.data[0]),1);parts.push(b,newB.subarray(op.data[0],op.data[1]));literal+=op.data[1]-op.data[0]}
 }
 return {pack:Buffer.concat(parts),ops:ops.length,literal};
}

export function apply(oldB,pack){
 if(pack.subarray(0,8).toString()!=='DNTDELT1')throw new Error('not a delta');
 const n=pack.readUInt32LE(8),h=JSON.parse(pack.subarray(12,12+n).toString());
 if(sha256(oldB)!==h.from)throw new Error('wrong base');
 const out=[];let p=12+n,size=0;
 while(p<pack.length){
  const k=pack[p];
  if(k===1){const o=Number(pack.readBigUInt64LE(p+1)),l=Number(pack.readBigUInt64LE(p+9));if(o+l>oldB.length)throw new Error('range');out.push(oldB.subarray(o,o+l));size+=l;p+=17}
  else if(k===2){const l=Number(pack.readBigUInt64LE(p+1));out.push(pack.subarray(p+9,p+9+l));size+=l;p+=9+l}
  else throw new Error('bad op');
  if(size>h.to_size)throw new Error('too long');
 }
 const r=Buffer.concat(out);if(sha256(r)!==h.to)throw new Error('result hash mismatch');return r;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,a,b,c]=process.argv.slice(2);
 if(cmd==='make'){
  const oldB=fs.readFileSync(a),newB=fs.readFileSync(b),t=Date.now();
  const {pack,ops,literal}=encode(oldB,newB,path.basename(b));
  const digest=sha256(pack);fs.mkdirSync(c,{recursive:true});fs.writeFileSync(path.join(c,digest+'.pack'),pack);
  apply(oldB,pack); // self-check
  console.log(JSON.stringify({name:digest+'.pack',size:pack.length,sha256:digest,from:sha256(oldB),from_size:oldB.length,to:sha256(newB),to_size:newB.length,ops,literal,ms:Date.now()-t}));
 }else if(cmd==='apply'){fs.writeFileSync(c,apply(fs.readFileSync(a),fs.readFileSync(b)));console.log('ok')}
 else{console.error('usage: delta.mjs make <old> <new> <outdir> | apply <old> <delta> <out>');process.exit(2)}
}
