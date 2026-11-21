#!/usr/bin/env node
'use strict';
/**
 * 一次性修复旧帖点赞/点踩数据：
 *   - posts.likedBy / dislikedBy 里有、post_votes 里没有的 openid → 补进记名表
 *   - 同一个 openid 在数组里重复 → 去重
 *   - 只对「至少有一个旧数组非空」的帖子重算 counts，避免把纯历史计数误清零
 *
 *   node scripts/repair-post-votes.cjs            # dry-run
 *   node scripts/repair-post-votes.cjs --confirm  # 写库
 */
const fs=require('fs'),path=require('path'),https=require('https');
const ROOT=path.join(__dirname,'..');
const OUT=path.join(ROOT,'data','post-vote-repair-20261020.json');
const CRED=path.join(__dirname,'.exam-upload.json'),TC=path.join(__dirname,'.exam-upload-token.json');
const ENV='cloud1-your-env-id';
function rj(p,f){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){return f}}
function req(url,method,body){return new Promise((res,rej)=>{const u=new URL(url);const h={'Content-Type':'application/json','User-Agent':'post-vote-repair'};if(body)h['Content-Length']=Buffer.byteLength(body);const q=https.request({hostname:u.hostname,path:u.pathname+u.search,method,headers:h},r=>{const b=[];r.on('data',d=>b.push(d));r.on('end',()=>res(Buffer.concat(b).toString()))});q.on('error',rej);q.setTimeout(120000,()=>q.destroy(new Error('请求超时')));if(body)q.write(body);q.end()})}
async function get(url){return (await req(url,'GET',null))}
async function token(){const c=rj(TC,null);if(c&&c.token&&c.at&&Date.now()-c.at<100*60*1000)return c.token;const cred=rj(CRED,null);if(!cred||!cred.appid||!cred.secret)throw new Error('缺少 '+CRED);const j=JSON.parse(await get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid='+encodeURIComponent(cred.appid)+'&secret='+encodeURIComponent(cred.secret)));if(!j.access_token)throw new Error('拿不到 access_token');fs.writeFileSync(TC,JSON.stringify({token:j.access_token,at:Date.now()}));return j.access_token}
async function tcb(t,action,query){const raw=await req('https://api.weixin.qq.com/tcb/'+action+'?access_token='+t,'POST',JSON.stringify({env:ENV,query}));try{const j=JSON.parse(raw);if(j.errcode===40001||j.errcode===42001)return{stale:true};return j}catch(e){return{bad:true,raw:raw.slice(0,200)}}}
function rows(raw){let a=[];if(Array.isArray(raw))a=raw;else{try{const j=JSON.parse(raw);a=Array.isArray(j.data)?j.data:[]}catch(e){}}return a.map(x=>typeof x==='string'?JSON.parse(x):x)}
function esc(s){return JSON.stringify(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
function uniq(a){const out=[],seen={};for(const x of (a||[])){const s=String(x||'');if(!s||seen[s])continue;seen[s]=1;out.push(s)}return out}
(async()=>{
  const confirm=process.argv.indexOf('--confirm')>=0;
  let t=await token();
  const q=async s=>{let j=await tcb(t,'databasequery',s);if(j&&j.stale){t=await token();j=await tcb(t,'databasequery',s)}if(j&&(j.bad||j.errcode))throw new Error('查询失败：'+(j.raw||j.errcode+' '+(j.errmsg||'')));return rows(j&&j.data)};
  const posts=await q("db.collection('posts').limit(1000).get()");
  const votes=await q("db.collection('post_votes').limit(1000).get()");
  const table={};
  votes.forEach(v=>{if(!v.postId||!v.openid)return;const k=String(v.postId);table[k]=table[k]||{like:{},dislike:{}};table[k][v.kind==='dislike'?'dislike':'like'][String(v.openid)]=1});
  const changes=[];const adds=[];
  for(const p of posts){
    const liked=uniq(p.likedBy), disliked=uniq(p.dislikedBy);
    // 只要帖子上还有任何赞踩数字或旧数组，就按记名表重算一次。
    // 这样连“没有任何投票记录的幽灵 1 赞”也会被清掉，计数才和一人一票严格一致。
    if(!liked.length&&!disliked.length&&!Number(p.likes)&&!Number(p.dislikes))continue;
    const ts=table[p.id]||{like:{},dislike:{}};
    const likeSet=Object.assign({},ts.like), dislikeSet=Object.assign({},ts.dislike);
    for(const oid of liked){if(!likeSet[oid]&&!dislikeSet[oid]){likeSet[oid]=1;adds.push({id:String(p.id)+'_'+oid,postId:String(p.id),openid:oid,kind:'like'})}}
    for(const oid of disliked){if(!likeSet[oid]&&!dislikeSet[oid]){dislikeSet[oid]=1;adds.push({id:String(p.id)+'_'+oid,postId:String(p.id),openid:oid,kind:'dislike'})}}
    const nextLikes=Object.keys(likeSet).length,nextDislikes=Object.keys(dislikeSet).length;
    const nextLiked=Object.keys(likeSet),nextDisliked=Object.keys(dislikeSet);
    const changed=Number(p.likes)!==nextLikes||Number(p.dislikes)!==nextDislikes||
      JSON.stringify(liked)!==JSON.stringify(nextLiked)||JSON.stringify(disliked)!==JSON.stringify(nextDisliked);
    if(changed)changes.push({id:String(p.id),title:p.title||'',before:{likes:Number(p.likes)||0,dislikes:Number(p.dislikes)||0,likedBy:p.likedBy||[],dislikedBy:p.dislikedBy||[]},after:{likes:nextLikes,dislikes:nextDislikes,likedBy:nextLiked,dislikedBy:nextDisliked}});
  }
  console.log('posts',posts.length,'votes',votes.length,'需要补记名表',adds.length,'需要重算帖子',changes.length);
  changes.forEach(c=>console.log(' ',c.id,c.title,'likes',c.before.likes,'->',c.after.likes,'dislikes',c.before.dislikes,'->',c.after.dislikes,'arrays',c.before.likedBy.length+'/'+c.before.dislikedBy.length,'->',c.after.likedBy.length+'/'+c.after.dislikedBy.length));
  if(!confirm){console.log('dry-run，未写库');return}
  let added=0,failed=0;
  for(const a of adds){
    const doc={_id:a.id,postId:a.postId,openid:a.openid,kind:a.kind,at:Date.now()};
    let j=await tcb(t,'databaseadd',"db.collection('post_votes').add({data:"+esc(doc)+'})');
    if(j&&j.stale){t=await token();j=await tcb(t,'databaseadd',"db.collection('post_votes').add({data:"+esc(doc)+'})')}
    if(j&&(j.bad||j.errcode)){failed+=1;}else added+=1;
    await new Promise(r=>setTimeout(r,60));
  }
  let updated=0;
  for(const c of changes){
    const data={likes:c.after.likes,dislikes:c.after.dislikes,likedBy:c.after.likedBy,dislikedBy:c.after.dislikedBy,votesMigrated:true};
    let j=await tcb(t,'databaseupdate',"db.collection('posts').where({id:'"+esc(c.id).slice(1,-1)+"'}).update({data:"+esc(data)+'})');
    if(j&&j.stale){t=await token();j=await tcb(t,'databaseupdate',"db.collection('posts').where({id:'"+esc(c.id).slice(1,-1)+"'}).update({data:"+esc(data)+'})')}
    if(!(j&&(j.bad||j.errcode)))updated+=1;
    await new Promise(r=>setTimeout(r,60));
  }
  fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify({at:new Date().toISOString(),adds,changes,added,failed,updated},null,2),'utf8');
  console.log('完成：补记名表',added,'失败',failed,'，更新帖子',updated,'，回滚快照',OUT);
})().catch(e=>{console.error(e.message||e);process.exit(1)})
