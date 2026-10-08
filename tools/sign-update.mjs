// Signs a Godot update manifest on the machine that holds the release signing key.
//   DNT_SIGNING_KEY=<local path to signing-private.pem> node sign-update.mjs [folder]
// Reads <folder>/payload.json (written by package-update.mjs --unsigned), checks it, signs it with Ed25519 and writes
// <folder>/godot-latest.json ({payload, signature}). The key file is only read here: it is never printed, copied or
// written anywhere, and the script refuses to sign if the key is not the one built into the game.
// Needs only Node.js (no packages).
import fs from 'node:fs';import path from 'node:path';import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';import {fileURLToPath} from 'node:url';
const PUBLIC_KEY='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEADvF0BJUIxae0zNDNgzzdfToFhVgyCkH878cxIdbSkmY=\n-----END PUBLIC KEY-----\n';
const fail=m=>{console.error('서명 실패: '+m);process.exit(1)};
const dir=path.resolve(process.argv[2]??path.dirname(fileURLToPath(import.meta.url)));
const payloadPath=path.join(dir,'payload.json');
if(!fs.existsSync(payloadPath))fail('payload.json이 없습니다: '+payloadPath);
const payload=fs.readFileSync(payloadPath,'utf8');
let p;try{p=JSON.parse(payload)}catch{fail('payload.json을 읽을 수 없습니다.')}
if(p.channel!=='godot'||!/^\d+\.\d+\.\d+$/.test(p.version)||!Array.isArray(p.files)||!Array.isArray(p.packs))fail('payload.json 형식이 올바르지 않습니다.');
for(const f of p.files)if(!['DungeonAndTower.pck','DungeonAndTower.exe'].includes(f.path)||!/^[0-9a-f]{64}$/.test(f.sha256))fail('허용되지 않은 파일: '+f.path);
for(const k of p.packs)if(k.name!==k.sha256+'.pack'||!/^[0-9a-f]{64}$/.test(k.sha256))fail('꾸러미 이름이 올바르지 않습니다.');
const keyPath=process.env.DNT_SIGNING_KEY;
if(!keyPath||!fs.existsSync(keyPath))fail('DNT_SIGNING_KEY에 서명 키 파일의 로컬 경로를 지정하세요.');
let key;try{key=createPrivateKey(fs.readFileSync(keyPath))}catch{fail('서명 키를 읽을 수 없습니다.')}
if(createPublicKey(key).export({type:'spki',format:'pem'}).trim()!==PUBLIC_KEY.trim())fail('이 키는 게임에 들어 있는 공개 키와 맞지 않습니다. 기존 키를 쓰세요.');
const signature=sign(null,Buffer.from(payload),key);
if(!verify(null,Buffer.from(payload),PUBLIC_KEY,signature))fail('서명 자체 확인에 실패했습니다.');
fs.writeFileSync(path.join(dir,'godot-latest.json'),JSON.stringify({payload,signature:signature.toString('base64')}));
console.log(`서명 완료: v${p.version} · 파일 ${p.files.length}개 · 꾸러미 ${p.packs.length}개 → godot-latest.json`);
