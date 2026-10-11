import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantTools, validAssistantArguments } from '../client/assistant-tools.mjs';
test('existing assistant MCP action exposes bounded attempt-scoped public answer drafts',()=>{
 const input={action:'draft',requestId:'draft-1',runId:'run',attemptId:'attempt',expectedRevision:1,sequence:1,body:'Public answer'};
 assert.equal(validAssistantArguments('room_assistant_action',input),true);
 assert.ok(assistantTools.find(t=>t.name==='room_assistant_action').inputSchema.properties.action.enum.includes('draft'));
 for(const patch of [{sequence:0},{sequence:1.5},{sequence:Number.MAX_SAFE_INTEGER+1},{body:'x'.repeat(65537)},{body:'\ud800'},{summary:'Misleading completion'},{state:'done'},{appliedInputMessageIds:['input']}]) assert.equal(validAssistantArguments('room_assistant_action',{...input,...patch}),false);
 assert.equal(validAssistantArguments('room_assistant_action',{...input,body:''}),true);
 assert.equal(validAssistantArguments('room_assistant_action',{...input,action:'publish',summary:'Ready'}),false);
});
