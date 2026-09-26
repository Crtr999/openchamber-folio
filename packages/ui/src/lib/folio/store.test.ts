import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useFolioStore } from './store';
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
 assert.equal(useFolioStore.getState().open,true);assert.equal(useFolioStore.getState().drafts[note.id].note.title,'Keep this');assert.equal(requests.length,1);
 useFolioStore.setState({drafts:{}});
});
