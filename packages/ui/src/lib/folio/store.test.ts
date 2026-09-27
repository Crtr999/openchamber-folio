import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPendingEdit, useFolioStore } from './store';
import { statusSchema, makeBlock, type FolioNote, type FolioRequest } from './schema';
const note:FolioNote={id:'F61645A9-DC34-499F-B2FA-CA73D7254098',title:'Start',icon:'',blocks:[makeBlock()],tags:[],favorite:false,excludedFromAI:false,isMeeting:false,trashed:false,created:1,modified:1};
const state=statusSchema.parse({notes:[note],selectedID:note.id,status:'',importing:false,importProgress:'',listening:false,dictation:'',speaking:false,paused:false,voiceID:'',rate:.4,voices:[],recording:false,recordingStarting:false,transcribing:false,recordingProgress:'',microphoneLevel:0,systemLevel:0,calendarConnected:false,events:[],reminders:false,fontSize:16,highlightStrength:.8,aiBusy:false,messages:[]});
test('edits arriving during a save are saved against the acknowledged revision',async()=>{
 const requests:FolioRequest[]=[];let version=1;
 useFolioStore.setState({drafts:{},status:state,error:undefined});
 useFolioStore.getState().bind({request:async input=>{
  requests.push(input);
  if(requests.length===1)useFolioStore.getState().edit({...note,title:'Second edit'});
  assert.equal(input.expectedModified,version++);
  return {id:'test',ok:true,state:{...state,notes:[{...input.note!,modified:version}]}};
 }});
 useFolioStore.getState().edit({...note,title:'First edit'});await useFolioStore.getState().flush();
 assert.equal(requests.length,2);assert.equal(requests[1].note?.title,'Second edit');assert.deepEqual(useFolioStore.getState().drafts,{});
});
test('failed save retains draft and blocks navigation instead of losing it',async()=>{
 useFolioStore.setState({drafts:{},status:state,open:true});const requests:FolioRequest[]=[];
 useFolioStore.getState().bind({request:async input=>{requests.push(input);return {id:'test',ok:false,error:'Conflict'};}});
 useFolioStore.getState().edit({...note,title:'Keep this'});await useFolioStore.getState().close();
 assert.equal(useFolioStore.getState().open,true);assert.equal(useFolioStore.getState().drafts[note.id].note.title,'Keep this');assert.deepEqual(requests.map(r=>r.command),['save','state']);
 useFolioStore.setState({drafts:{}});
});
test('a save that lost its base is saved again on top of the latest version',async()=>{
 useFolioStore.setState({drafts:{},status:state,open:true});const requests:FolioRequest[]=[];let saves=0;
 const moved={...note,modified:note.modified+50};
 useFolioStore.getState().bind({request:async input=>{requests.push(input);
  if(input.command==='state')return {id:'t',ok:true,state:{...state,notes:[moved]}};
  saves+=1;if(saves===1)return {id:'t',ok:false,error:'This page changed in another view.'};
  return {id:'t',ok:true,state:{...state,notes:[{...moved,title:'Keep this',modified:moved.modified+1}]}};}});
 useFolioStore.getState().edit({...note,title:'Keep this'});await useFolioStore.getState().flush();
 assert.deepEqual(requests.map(r=>r.command),['save','state','save']);assert.equal(requests[2].expectedModified,moved.modified);
 assert.deepEqual(useFolioStore.getState().drafts,{});
});
test('typing an editor still holds is handed over before the page is saved',async()=>{
 useFolioStore.setState({drafts:{},status:state,open:true});const saved:string[]=[];
 useFolioStore.getState().bind({request:async input=>{saved.push(input.note?.title??'');return {id:'t',ok:true,state:{...state,notes:[{...input.note!,modified:input.note!.modified+1}]}};}});
 const unregister=registerPendingEdit(()=>{unregister();useFolioStore.getState().edit({...note,title:'Typed on the phone'});});
 await useFolioStore.getState().flush();
 assert.deepEqual(saved,['Typed on the phone']);assert.deepEqual(useFolioStore.getState().drafts,{});
});
test('an edit saved after the AI changed the page keeps both changes',async()=>{
 const other=makeBlock();const page={...note,blocks:[{...note.blocks[0],text:'mine'},{...other,text:'old'}]};
 const aiVersion={...page,blocks:[page.blocks[0],{...other,text:'from the AI'},{...makeBlock(),text:'AI line'}],modified:page.modified+10};
 useFolioStore.setState({drafts:{},status:{...state,notes:[page]},open:true});const saves:FolioNote[]=[];let first=true;
 useFolioStore.getState().bind({request:async input=>{
  if(input.command==='state')return {id:'t',ok:true,state:{...state,notes:[aiVersion]}};
  if(first){first=false;return {id:'t',ok:false,error:'This page changed in another view.'};}
  saves.push(input.note!);return {id:'t',ok:true,state:{...state,notes:[{...input.note!,modified:aiVersion.modified+1}]}};}});
 useFolioStore.getState().edit({...page,blocks:[{...page.blocks[0],text:'mine, edited'},page.blocks[1]]});await useFolioStore.getState().flush();
 assert.deepEqual(saves[0].blocks.map(b=>b.text),['mine, edited','from the AI','AI line']);
});
