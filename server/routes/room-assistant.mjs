import { RoomAssistant } from '../room-assistant.mjs';
import { validId } from '../../src/events.js';
const id={type:'string',minLength:1,maxLength:128};
const params={type:'object',required:['roomId'],properties:{roomId:id}};
const body={type:'object',required:['action','requestId'],additionalProperties:false,properties:{
  action:{type:'string',enum:['configure','invoke','contribute','resolve','claim','report','publish','draft','pause','cancel','resume']},requestId:id,runId:id,sourceMessageId:id,attemptId:id,resultMessageId:id,
  body:{type:'string',maxLength:65536},sequence:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
  expectedAttemptId:{...id,type:['string','null']},expectedRevision:{type:'integer',minimum:0},name:{type:'string',minLength:1,maxLength:64},coordinatorMemberId:{type:['string','null']},conflict:{type:'boolean'},state:{type:'string',enum:['working','needs_input','paused','cancelled','done','failed']},summary:{type:'string',minLength:1,maxLength:2000},appliedInputMessageIds:{type:'array',items:id,maxItems:100}
}};
export async function roomAssistantRoute(ctx) {
  const roomId=ctx.params.roomId;
  if(!validId(roomId)) ctx.reject(422,'invalid_room','Choose a room ID');
  const selected=ctx.roomCredentials(ctx.req,ctx.url);
  const fence=selected.mode==='account' ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const write=ctx.req.method==='POST';
  const authorize=()=>{
    const auth=ctx.roomAuth(selected,roomId,fence);
    if(selected.bearer && auth.credentialScope!=='room') ctx.reject(403,'access_denied','Bearer account sessions are not accepted');
    if(!selected.bearer && auth.kind!=='session') ctx.reject(401,'unauthenticated','Browser session required');
    if(auth.kind==='api-key') {
      const needed=write?'rooms:write':'rooms:read';
      if(!(auth.apiKeyScopes??[]).some(scope=>scope===needed || scope.endsWith(':*') && needed.startsWith(scope.slice(0,-1)))) ctx.reject(403,'insufficient_scope',`API key lacks ${needed}`);
    }
    if(write) ctx.protectWrite(ctx.req,auth,selected.bearer);
    return auth;
  };
  const auth=authorize();
  ctx.rate(`read:${auth.credentialHash}`,600);
  const input=write ? await ctx.body(ctx.req) : null;
  if(write) ctx.rate(`${input?.action==='draft'?'assistant-draft':'write'}:${auth.credentialHash}`,input?.action==='draft'?120:60);
  const assistant=new RoomAssistant(ctx.store);
  // publish posts the run's answer as the coordinator; thread the caller's
  // own credential so the fenced post authenticates as the reserved host.
  const value=write ? assistant.apply(roomId,input,authorize,selected.token) : assistant.list(roomId,authorize);
  return ctx.json(ctx.res,200,value,ctx.req.method==='HEAD');
}
export const ROOM_ASSISTANT_ROUTES=Object.freeze(['GET','HEAD','POST'].map(method=>Object.freeze({id:`room-assistant-${method.toLowerCase()}`,method,path:'/api/rooms/{roomId}/assistant',auth:'room',capability:null,scope:'room',handler:roomAssistantRoute,schema:{params,...(method==='POST'?{body}:{}),response:{type:'object'}},events:[]})));
